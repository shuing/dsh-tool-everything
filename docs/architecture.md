# dsh-tool-everything 架构

本文件回答「为什么这样实现」，不是使用说明。参数、错误码与调用原则见 `README.md`，可执行的契约在 `test/verify.mjs`。文中的 `文件:行号` 与行数按 **0.5.3** 的源码写，只作定位线索：断言一律钉在行为上，不钉行号；插一个 import 就会整体下移一行，行号漂了以代码为准（本轮同步时逐条核对过 7 处关键行号与 8 个文件的行数）。

## 1. 数据流

一次 `everything_search` 调用，从工具入口到 DLL 只有一条路：

1. `lib/components/everything/index.js:598` `execute(args, exec)` —— `assertSignal`（一次性探针，定义在 `:92`）、`parseArgs`、`maxResults` / `offset` 钳位、`exclude` 解析、`sort` / `type` 白名单校验、`countOnly` 与正 `offset` 互斥。
2. `lib/components/everything/index.js:393` `runQuery` —— 每个实例一条在途链 `rt.chain`（实例由 `createQueryRuntime():115` 建），一次只放一条请求进 worker（并发是排队，不是并行）。
3. `lib/components/everything/index.js:397` `runQueryUnlocked`（实例版是 `:409` 的 `runQueryUnlockedOn`）—— 组请求体：`buildSearch`（`path:` / `file:` / `folder:` / `!path:` 全在这里拼）、`sort`、`offset`；请求 flags 由 worker 侧按 `countOnly` 决定。
4. `lib/components/everything/index.js:210` `askWorker` → `new Worker(fileURLToPath(WORKER_URL))`（`WORKER_URL` 在 `:104`，值取自 `lib/paths.mjs:19` 的 `workerUrl`，指向 `lib/components/everything/query-worker.mjs`）→ `postMessage`。
5. `lib/components/everything/sdk.mjs:220` `loadSdk` → `koffi.load(native/Everything64.dll)` → 绑定 `Everything_Set*` / `Everything_QueryW` / `Everything_Get*`（`lib/components/everything/sdk.mjs:233-257`）。
6. worker 回一条消息 → `lib/components/everything/index.js:153` 的 `message` 监听 → `settleRequest`（`:174`）→ `runQueryUnlockedOn` 组装 value（`sort:path` 时置 `value.compacted`，见第 6 节）→ `formatOutput`（定义在 `lib/shared/format.mjs:147`，调用在 `lib/components/everything/index.js:930`）出模型可读文本，`presentationMeta`（`:932`）出搜索卡片。

主线程只做拼串、校验与格式化；阻塞的 `Everything_QueryW` 只在 worker 里跑。

## 2. 只读边界

插件注册六个工具：`everything_search`（`applyTool`）、只读探活 `everything_status`（`applyStatusTool` + `lib/components/everything/status.mjs`，只读加载标志与版本，不发起查询、不解码结果），以及内容侧的 `anytxt_search` / `anytxt_read` / `anytxt_status` / `anytxt_sync_index`（`applyAnytxtTools`，`lib/components/anytxt/index.js:86`），另有两个 prompt 段（order 3254 / 3255，取值在 `lib/shared/prompt-orders.mjs`）。SDK 侧只绑读路径：

- 搜索只设状态：`SetSearchW`、`SetMatchPath`、`SetMatchCase`、`SetRegex`、`SetMax`、`SetOffset`、`SetSort`、`SetRequestFlags`、`QueryW`（`lib/components/everything/sdk.mjs:233-241`）。
- 结果只读：`GetNumResults`、`GetTotResults`、`IsFolderResult`、`GetResultFullPathNameW`、`GetResultSize`、`GetResultDateModified`、`GetLastError`、`IsDBLoaded`、`GetMajorVersion` / `GetMinorVersion`（`lib/components/everything/sdk.mjs:242-257`）。
- SDK 侧没有任何写、删、移动、重命名、同步、OCR、内容提取的绑定，也不打算加：Everything 这一侧永远只按名查询，改名与删除不在工具职责内；内容检索是 `grep` 与（若接入）Anytxt 的活。
- 内容检索走 `127.0.0.1:9920` 的 JSON-RPC，不 bind 任何 DLL，因此上面两张绑定表一行不动；实测口径见 `README.md` 的「Anytxt 实测口径」一节。
- 写路径只有一条：`anytxt_sync_index` → `anytxt.v1.syncIndex`，只对用户显式给出的绝对目录建库（路径先归一为反斜杠、目录先做存在性校验、`errno 0` 不当成功凭据，三条都是实测出来的坑）；删除、移动、重命名一概没有绑定。Everything SDK 侧仍只有上面两张只读表。
- 不替用户起进程：`autoStart` 默认 `false`（外壳 `lib/index.js:184`，文件面取用点在 `lib/components/everything/index.js:428`），只有调用方显式打开时才走 `Everything.exe -startup`。

## 3. worker 内的原生调用不可取消（实测，不是推断）

- `Everything_QueryW` 是阻塞调用，因此整体搬进 `lib/components/everything/query-worker.mjs`，主线程事件循环保持空闲。证据是 `test/verify.mjs:738` 起那条 live 断言：一条 `regex:.*`（实测约 30ms）与 5ms 定时器赛跑，定时器必须赢；对照步先验证本机 1ms interval 空闲时确实累加，否则只记 inconclusive，不假装通过。
- `worker.terminate()` 不能打断已经在 DLL 里的原生调用：实测 terminate 在 6–8ms 内返回，但线程要等原生调用返回才真正退出，之后还会补发一条回复（`lib/components/everything/index.js:197` 的 `retireWorkerOn` 上方那段实测注释记的就是这次）。
- 所以 abort 的语义是「换新 worker、丢掉旧回复」，从不宣称打断了在途查询；默认超时预算因此偏短（`SEARCH_TIMEOUT_MS = 8e3`，`lib/components/everything/index.js:72`）。

## 4. 错误码三层

三层刻意不合并——谁来修、下一步做什么完全不同。

| 层 | 位置 | 典型码 | 模型该怎么反应 |
| --- | --- | --- | --- |
| SDK 层 | `lib/components/everything/sdk.mjs:117` `EVERYTHING_ERROR_CODES` 与 `lib/components/everything/sdk.mjs:169` `describeLastError` | `EVERYTHING_NOT_RUNNING`、`EVERYTHING_OUT_OF_MEMORY`、`EVERYTHING_ERROR_<n>` | 本机索引不可用，退回 `grep` / `glob` 并说明 |
| 工具与传输层 | `lib/components/everything/index.js:104-222`（worker 实例状态与错误消息段；`askWorker` 自 `:210` 起到 `:222` 闭合） | `SEARCH_ABORTED`、`EVERYTHING_WORKER_FAILED`、`EVERYTHING_WORKER_EXITED`、`EVERYTHING_WORKER_REPLACED` | 重试即可；`REPLACED` 是重载换了 worker，重发就是 |
| 宿主能力层 | `lib/index.js:69` `HOST_ERROR_CODES`、`lib/index.js:88` `probeHost`、`lib/components/everything/index.js:92` `assertSignal` | `HOST_CAPABILITY_MISSING`、`HOST_MISSING_SIGNAL` | 装或升级 DSH；这不是搜索本身的问题 |

`lastError=0` 单独解释为 `EVERYTHING_ERROR_0`（报了失败却没置码，通常索引未就绪），不与映射表里任何一条混用；表外数值原样透出 `EVERYTHING_ERROR_<n>`，不做猜测性映射。

`everything_status` 的四种判决不属于上面任何一层：`EVERYTHING_READY` 与 `EVERYTHING_INDEX_NOT_LOADED` 是答案（能用 / 索引未加载），`STATUS_SKIPPED` 与 `STATUS_ABORTED` 是「探活自己没答」，两者都不许读成引擎 DOWN。`EVERYTHING_INDEX_NOT_LOADED` 本轮未实测：本机 Everything 在跑，要拿这一态得停掉用户的实例，所以它目前只有代码路径、没有实测证据，后来人别当已验证事实引用。

四条判决是代码里的分支，不是 `code` 空间的全部：`lib/components/everything/status.mjs` 另有两条透传路径——SDK 未加载、探活时 Everything 没应答——它们把 SDK 自己的码原样当 `code` 返回（`EVERYTHING_SDK_LOAD_FAILED`、`EVERYTHING_NOT_RUNNING` 等），透传码原样透出、不当判决读。模型视图只给 `ok`/`code`/`message`/`version`/`path`，修复步骤一概不给——模型手里有 pwsh/grep/glob，看到「去装 DLL」会去修环境，正解是退回 grep/glob 并说明本机索引不可用。

## 5. 组件结构：为什么拆成两条组件行

两条组件行各管一面，`wc -l` 实测：包本体外壳 `lib/index.js` 234 行、文件名组件 `lib/components/everything/index.js` 1347 行、内容组件 `lib/components/anytxt/index.js` 473 行（它的 JSON-RPC 客户端 `lib/components/anytxt/anytxt.mjs` 776 行）；共享件四份 `lib/shared/format.mjs` 277 行、`lib/shared/type-name.mjs` 14 行、`lib/shared/prompt-orders.mjs` 13 行、`lib/shared/config.mjs` 25 行；`lib/paths.mjs` 是 DLL 路径与 worker 入口的唯一一处定义。拆的理由是结构需求，不是行数：

- 开关要与能力面一一对应。注册点搬进各组件的 `apply(ctx, caps)`，外壳只做「探测宿主能力 → 组 caps」，注册全交给行自己；关掉 `file` 那一行，`everything_*` 随之不在、`anytxt_*` 照常上线，只开 `file` 则反之。注册留在外壳时开关只是装饰。证据是 `test/verify.mjs` 的四组合用例（都不加载／只 file／只 content／两面全接），断言工具名集合与 prompt 段 order 集合逐字相等。
- 文案与 schema 的唯一来源跟着注册面走：`buildParameters`、`applyTool` 的 tool description 与 prompt 段在文件面组件里，四个 `anytxt_*` 工具与那段 prompt 在内容面组件里。共享件只有三处——`format.mjs` 出模型可读文本、`type-name.mjs` 出探测的 expected/got、`prompt-orders.mjs` 是 order 的唯一来源（一行一个数，不许 `+1` 之类算术）。
- 实测常量的唯一来源仍是 `lib/components/everything/sdk.mjs`（主线程与 worker 共用一份），两份必漂；DLL 路径与 worker 入口收到 `lib/paths.mjs`，从 `lib/` 起算、不数 `../` 层数，搬文件不会指错地方。
- 触发再拆的条件仍是结构需求，不是行数：接入第二个引擎，或出现日志与路由需求。

## 6. `sort:path` 的前缀压缩：只省目录，不动事实

`sort:path` 时正文按「目录打一次 + 文件缩进」渲染，重复的目录前缀不再每行重印。这是**纯呈现层**改动，三个不变量决定了它的边界：

- **只在 `sort:path` 开启**。Everything 按路径排序时同目录天然相邻；按 `name` / `size` 排序时目录被打散（实测同一份 500 条：name 151 段、size 164 段、path 仅 90 段，目录唯一数 89），此时压缩只会把 `..\` 乱跳堆给读的人。开关落在 `lib/components/everything/index.js:782` 的 `value.compacted`，`formatOutput` 只读这个布尔值（`lib/shared/format.mjs:211`），不参与排序决策、参数校验或分页计算。
- **只缩短目录**。文件名与「大小 / 本地时间」两列与 `formatItem` 逐字节相同（`lib/shared/format.mjs:64` 与 `:108` 共用同一套 `formatSize` / `formatMtime`），所以压缩行仍然携带同样的事实，只是不再重复一个已经在屏幕上的目录。
- **分页契约一字未动**。`nextOffset` 仍是 `offset + items.length`；每页首行的 `previous` 恒为 `undefined`，因此**每页第一行永远是完整绝对路径**——组被翻页切开时，那一页仍能独立定位。这是「页内连续、页间不保证组完整」这一取舍能被接受的前提。

四条出口（`lib/shared/format.mjs:108` `formatItemCompacted`）各有实测依据，没有一条是保险起见加的：

| 出口 | 触发条件 | 为什么不能写跳转 |
| --- | --- | --- |
| 绝对目录行 | 首行（`previous` 未定义） | 页首必须自足，否则单独看这一页无法定位 |
| 绝对目录行 | 换盘符（`dirs[0] !== previous[0]`） | `..` 到不了另一块盘，`..\D:\b` 是不存在的路径 |
| 绝对目录行 | 上跳层数 > `MAX_HOP_LEVELS`(3) | 点号比省下的前缀还长，且没有人能数清十层 `..` |
| 纯缩进行 | 同目录（`shared === dirs.length && dirs.length === previous.length`） | 目录已在上一行，重印纯属冗余 |
| `..\` 前缀行 | 其余情况 | 上跳层数 = 上一层目录深度 − 共享段数 |

上跳层数必须**按层数写**，不能固定一个 `..`：从深度 10 的 `...\Dism++\Config\Languages` 跳到共享 5 层的另一个 `图吧工具箱202502\...` 只写一个 `..`，会解析到 `...\Dism++\Config\..\图吧工具箱202502`——一个不存在的兄弟目录。同理，`shared === dirs.length` 不等于「同目录」：**目录变浅**时它也成立（`C:\a\b` 之后出现 `C:\a` 的文件），若只打缩进行，那个文件会被读成仍在更深的 `b` 里。两条都是真实页面上抓到的，钉在 `test/verify.mjs` 里。

`MAX_HOP_LEVELS = 3` 是量出来的，不是拍的：一份 13 行的真实样本里，最深一跳写了 10 个 `..\`，所有跳转行加起来占压缩版 **31%**，页面总节省跌到 21%——省下的目录前缀又被点号还了回去，还多出一堆数不清的点；加上限后跳转占比降到 **6.9%**，总节省反而升到 22.3%。

**还原能力是这项功能的验收标准**，不是体积。`test/verify.mjs` 里有一条端到端用例：用一个**独立实现**的解析器（`..` 逐段上跳）把压缩输出还原成原始路径序列，再与输入逐条比对——这是唯一能证明「省 token 没有换掉定位能力」的检查，只钉输出形状盖不住。500 条真实路径的还原率是 500/500，体积 69467 → 34587 字符（约 −50%）。

## exports 与组件入口

`package.json` 的 `exports` 里，`./everything`、`./anytxt` 两条是组件入口，各自指向 `lib/components/<组件>/index.js`；同名的 `./<组件>/package.json` 是给 loader 读组件身份用的。

`"./*": "./*"` 是**兼容兜底，不是组件入口**：`exports` 一旦加上就会关掉子路径通配，而 `test/verify.mjs` 按路径直接 import `lib/components/everything/sdk.mjs`，删掉这条会断测试，也会断既有按路径消费的调用方。它与 `"//exports"` 那条顶层说明键成对出现，任何一次搬文件之后都要重核它是否还够用。

`cordis.patch.yml` 的两条组件行里，`id` 与 `name` 分开写：`id` 用连字符（`dsh-tool-everything-everything` 与 `dsh-tool-everything-anytxt`），`name` 只用机读标识（`dsh-tool-everything/everything` 与 `dsh-tool-everything/anytxt`）。**不许把显示名塞进 `name`，也不许带 `&`**——反面教材是 ops 的 `lib/components/shell/index.js:5`，`export const name` 写成 `"dsh-ops-bash & host PowerShell"`，错一层就整行抛错。

# dsh-tool-everything

> 🔀 **本仓库是 [roxyyn0304/dsh-tool-everything](https://github.com/roxyyn0304/dsh-tool-everything) 的 fork**，
> 在上游 `0.4.14` 的基础上继续维护；本 fork 相对上游改了什么见下文
> 「🔀 本 fork 相对上游的差异」一节。
> 代码以 MIT 许可发布，**原始版权归原作者 roxyyn0304 所有**，上游 [LICENSE](LICENSE) 原文保留未改。

## 📖 插件简介

给 DSH Agent 加两个能力：**按文件名秒搜全盘**（Everything 索引 + koffi），**按正文搜 PDF/DOCX 等文档**（本机 Anytxt 索引）。共 6 个工具，装好即用，不用开 HTTP 服务，也不用 es.exe。

- ⚡ **极速**：直接调用 Everything SDK（koffi FFI），走 IPC 通道——毫秒级响应
- 🔍 **完整语法**：通配符 `*.pdf`、`path:C:\code`、`ext:zip`、`size:>10mb`、`regex:`、`|` 或、`!` 非
- 📄 **内容检索**：走本机 Anytxt 的 JSON-RPC（仅回环），读到片段或整篇抽取文本
- 🎯 **结构化结果**：返回路径 + 大小 + 时间 + 是否文件夹，UI 自动渲染搜索卡片
- 📦 **零安装负担**：自带 `Everything64.dll`（x64，voidtools 签名），无需额外组件
- 🔥 **DSH 原生**：Cordis 插件，两条组件行可分别开关，支持 HMR 热重载

## 🛠️ 安装说明

**前提**

- Windows 系统
- [Everything](https://www.voidtools.com/Everything-Download) **正在运行**（文件名面）
- Anytxt（`ATGUI.exe`）在运行且目标目录已建索引（内容面，可选；没装只影响 `anytxt_*`）
- DeepSeek Harness（DSH）**≥0.2.0-rc.1**（`koffi` 随包依赖）。版本号只作兜底提示，能不能跑由插件加载时的**宿主能力探测**决定

**安装**

```powershell
dsh plugin --profile web add "github:shuing/dsh-tool-everything"
```

装完**硬刷新浏览器**（`Ctrl+Shift+R`），**新开会话**即可使用。

> ⚠️ 请确认安装的是 **0.5.3 及以上**版本。0.2.0 的 `peerDependencies`
> 只声明了 `^0.1.0-rc.6`，会被 DSH 0.2.x 的兼容性检查判为不兼容并拒绝安装
> （报错 `incompatible-version`）。现行声明为 `engines.dsh: ">=0.2.0-rc.1 <1.0.0"`，
> 各条 DSH `peerDependencies` 同区间——版本区间只是安装期兜底提示，真正决定能不能跑的是下文的宿主能力探测。

**从旧版本升级**

```powershell
dsh plugin --profile web add "github:shuing/dsh-tool-everything"
```

若之前装过 0.2.0，重新执行上面的 `add` 即可覆盖。若 profile 里残留了
0.2.0 的版本豁免（`compatibility.json`），升级后可以删掉，不再需要。

### 0.4.14 → 0.5.0 的破坏性变更

`anytxt_search` 的**输出行与大模型可见语义**变了，所以走次版本号而不是修订号：

1. 每个命中行现在以 `ref<TAB>路径<TAB>大小<TAB>时间` 开头，`ref` 是第一列（这是 `anytxt_read` 的唯一入口；旧版根本没渲染它）；
2. 引号整句**真的生效了**：引号留在 `pattern` 里发给服务端，带引号的命中集从「等于裸词」变成「裸词的子集」；
3. `nextOffset` 按服务器**原始返回行数**前进，不再用过滤后条数——被排除的行落在页内时，相邻两页不再重复；
4. 新增 `exclude` 参数，默认排除写进结果头 `(N exclusion rules applied)`，`exclude: ""` 可关闭；
5. `max` 的 fragments 上限从 32 改为 **8**（服务端上限就是 8，实测传 3/8/32/300 都回 8 段）；
6. `path` 与搜索串里已有的 `path:` 撞车改为**报参数错误**（旧行为静默丢掉 `path`）；
7. `anytxt_status` 不再因探针 0 命中回 `ok: false`（一次探针分不出「索引为空」与「没有这个词」）。

`everything_search` 的行为只有一处变化：`path` / `path:` 撞车从静默改为显式失败。不传这两个参数时行为不变。

### 0.5.1 修复

1. `anytxt_search` 的 `modified` 列改成**本地时间**。索引回的是 ISO(UTC)，旧实现只把 `T`／`Z` 去掉就印出来，同一个文件会比 `everything_search` 那一列早整整一个时区（本机 8 小时），且两边都没有时区标记——读的人只会得出「这是两个不同版本」。现在两个面共用 `lib/shared/format.mjs` 的同一个本地时间格式化函数。
2. `anytxt_read` 在 `ref` 的 fid 不存在时不再静默返回 `0 of 0 characters`（那是「读到一个空文档」的语义），改报 `ANYTXT_FID_NOT_FOUND`。实测服务端对不存在的 fid 回 `errno 1` + `text: null`，对有效 fid 回 `errno 0` + 字符串，所以两者可区分；`GetFragmentAll` 两种都回 `errno 0`，`fragments` 侧分不出，只有 `full` 能报。此前 `errno` 只在 `anytxt_sync_index` 那条路径上被读过。

### 0.5.3 `sort:path` 前缀压缩

同一条查询，`sort:path` 的文本比按 `name` 排序省约一半字符（500 条真实数据 69467 → 34587，约 −50%），**`items` 与分页完全不变**：

1. **形态**：目录单独成行，文件缩进四格；跳转写成 `..\` 前缀，层数 = 上一目录深度 − 共享段数（所以跨两层是 `..\..\x`，不是一个 `..\x`）。只缩短目录，文件名与「大小／时间」两列与 `formatItem` 逐字节相同。
2. **只在 `sort:path` 开启**。按 `name`/`size` 排序时目录被打散（实测 500 条：name 151 段、size 164 段、path 仅 90 段），压缩只会把 `..\` 乱跳堆给读的人。开关是 `value.compacted`，`formatOutput` 只读这个布尔值。
3. **三种情况回退绝对路径**：每页第一行（页首必须自足）、换盘符（`..` 到不了另一块盘）、上跳超过 3 层（`MAX_HOP_LEVELS`，点号比省下的前缀还长）。最后一条是量出来的：一份 13 行样本里最深一跳写了 10 个 `..\`，跳转行占压缩版 31%、总节省跌到 21%；加上限后降到 6.9%，总节省反升到 22.3%。
4. **修掉三个真实页面抓到的 bug**：多级跳转曾只写一个 `..`（指向不存在的兄弟目录）；目录变浅时曾只打缩进行（文件被读成仍在更深的目录里）；盘符根曾印成 `C:`（少尾分隔符，解析后成 `\C:\...`）。
5. **验收标准是还原能力，不是体积**。`test/verify.mjs` 用一条独立实现的解析器把压缩输出还原成原始路径序列再逐条比对，500 条真实路径还原 500/500；另加 5 条形状断言钉住上面每条回退规则。改后实测 `216 passed / 0 skipped / 0 failed`（anytxt 侧 `83 passed / 0 failed`）。
6. 与既有参数零冲突：`countOnly` / `offset` 分页 / `descending` / `maxResults` 钳位 / `exclude` / `path` / `type:dir` / 空结果 / 跨盘 / 特殊字符路径（`$`、空格、中文、超长、尾随空格）逐项实测通过。压缩逻辑不参与排序决策、参数校验或分页计算。

### 0.5.2 定义瘦身：约束搬进运行时输出

`anytxt_*` 四个工具的 description 只留骨架，把「什么时候才用得上」的细节搬到**每次的结果里**（与 `everything_search` 把 `path ignored` / 零命中出路写进 header 是同一做法）：

1. description 实测瘦身：`anytxt_search` 1014→674、`anytxt_read` 1085→524、`anytxt_status` 402→193、`anytxt_sync_index` 958→600 字符；提示词段 3255 仍是 381 字符（预算 400）。
2. 类型边界、`accepted ≠ ready`、片段上限与中文倒序、续读句柄、`content index only` 全部改成渲染尾部／页脚，见各工具的「运行时输出」。
3. `anytxt_search` 的未知参数改为**报参数错误**（此前 `countOnly` 被静默忽略，却照样列出路径，读起来像「只报了数」）。
4. 头部 `(offset X)` 修好：`offset > 0` 时必出现，不再把非首页印成 `Found N results`。
5. `anytxt_status` 的 description 与代码对齐：探针确实会发一次固定词、仅 txt 的 `Search`，所以不再写「no query runs」，改写成「不读文档、不跑调用方的查询」。
6. `everything_search` 同口径收口：定义收敛为五段（Usage / Principle / Semantics / Report / Scope），原先的 Constraints 整段搬进运行时输出（报错文案、header 追加句、页脚出路）。随之把 `test/verify.mjs` 里 9 条仍盯着主 description 要「约束措辞和旧段名」的断言改为读它现在真正所在的文本——`sort` / `descending` / `countOnly` / `maxResults` 读各自参数 description，`regex:` 引号形态读 `search` 参数 description，探活分工读 prompt 段，六段改五段；并加一条反向守卫：主 description 不许再复述 `maxResults` 上限。改后当时实测 `201 passed / 0 skipped / 0 failed`（现为 216，后续版本又加了用例）。

## 📁 文件树

```
dsh-tool-everything/
├── lib/
│   ├── index.js                       外壳：宿主能力探测 + 组 caps（不注册工具）
│   ├── paths.mjs                      DLL 路径与 worker 入口的唯一定义处
│   ├── components/
│   │   ├── everything/                文件名面
│   │   │   ├── index.js               everything_search / everything_status 注册 + 参数 schema
│   │   │   ├── sdk.mjs                koffi 绑定 + 实测常量（主线程与 worker 共用一份）
│   │   │   ├── query-worker.mjs       阻塞查询所在的 worker 线程
│   │   │   ├── status.mjs             everything_status 探活
│   │   │   ├── package.json           组件身份（loader 用）
│   │   │   └── locale/en.json
│   │   └── anytxt/                    内容面
│   │       ├── index.js               四条 anytxt_* 工具注册 + 模型可见文本
│   │       ├── anytxt.mjs             JSON-RPC 客户端 + 协议实测
│   │       ├── package.json
│   │       └── locale/en.json
│   └── shared/                        两面共用，禁止各复制一套
│       ├── config.mjs                 唯一一份 Config schema
│       ├── limits.mjs                 上限与预算校验（offset 钳位、坏预算回退）
│       ├── format.mjs                 模型可见文本（含本地时间格式化）
│       ├── prompt-orders.mjs          prompt 段 order 的唯一来源
│       └── type-name.mjs              探测报错用的 expected/got
├── native/
│   ├── Everything64.dll               随包的 Everything SDK（x64，voidtools 签名）
│   └── LICENSE                        SDK 自己的许可
├── test/
│   ├── verify.mjs                     文件名面 + 打包 + 文档互校
│   └── anytxt.verify.mjs              内容面，全离线（注入 fetchImpl）
├── docs/architecture.md               为什么这样实现（数据流、只读边界）
├── cordis.patch.yml                   三条 loader 行：外壳 + 两个组件
├── dsh.plugin.json                    插件元数据（显示名、平台、tags、homepage）
├── package.json                       依赖、exports、scripts、engines.dsh
├── package-lock.json
├── .gitignore
├── LICENSE                            MIT，上游原文保留
└── README.md
```

## 🧰 工具说明

六个工具全部无条件注册，没有开关要记。分工：

| 工具 | 干什么 | 依赖 |
| --- | --- | --- |
| `everything_search` | 按**文件名**全盘搜索（Everything 索引） | Everything 在运行 |
| `everything_status` | 探活：`everything_search` 现在能不能用 | 同上 |
| `anytxt_search` | 按**正文**搜文档，返回带 `ref` 的命中页 | Anytxt 在运行 + 目录已索引 |
| `anytxt_read` | 按 `ref` 读片段或整篇抽取文本 | 同上 |
| `anytxt_status` | 探活：内容检索现在能不能用 | 同上 |
| `anytxt_sync_index` | 按目录建库／刷新索引（**唯一会改索引状态**的一步） | 同上 |

### `everything_search`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `search` | string | 必填，Everything 搜索表达式；定义只枚举六个常用算子（`path:`／`ext:`／`size:`／`dateModified:`／`folder:`／`content:`），实现上 **Everything 原生语法原样透传**（`size:>10mb`、`dateModified:thisweek`、`ext:zip`、`content:词`、`folder:`，实测可用：`size:>100mb` @ `C:\Windows` 回 60 条）；`regex:` 双引号形态承载空格且**大小写不敏感**（实测 `regex:"DEEPSEEK-AI"` 命中 `@deepseek-ai`）；`ext:` **只有前缀没有值**时直接报参数错误（`ext: requires a value`，旧版回 5／1／0 那种既不是「无过滤」也不是错误的数） |
| `path` | string | 目录收窄，渲染成 `path:<value>`；含空格自动加引号。**仅接受目录**：指向一个文件会报参数错误（`path:` 是前缀 scope，文件路径恒 0 命中，实测 `*.md` + 文件 path 回 0 条且旧版毫无提示），改传父目录并把文件名写进 `search`，或改用 `ext:`。尾部通配会被折叠成父目录：实测 `path:C:\x\*` 回 **0 条**、`path:C:\x` 回 **19 条**——`path:` 本来就是前缀匹配、已含全部子目录，尾部 `*` 只会把 scope 变成匹配不到的字符串。目录不存在默认报错，错误消息给出最近存在的父目录与两条出路（确认目录、省略 `path:`，或传 `pathMustExist: false` + `allDrives: true`）——旧文案里「改通配」那条出路已被实测推翻、已删除。**尾部通配一律折叠成静态前缀**：`dir\*`、`dir\**`、`name*` 三种写法：`dir\\*`／`dir\\**` 折成该目录本身（等价直连），`name*` 折成名字前缀（保留前缀语义、不补尾分隔符）；实测旧版 `path: …\dsh-voice*` 与 `…\dsh-voice-s*` 都回 **0 条**、直连却有命中，且不报路径无效），再交给 `path:` 自己的前缀匹配；中间通配（`C:\a*\b`）没有可证明的等价物，原样保留。通配 scope 的**父目录也不存在**时同样报路径错误（带 `nearest existing parent: …`），不再落成 `no match in the index`。搜索串里已带 `path:` 时再传 `path` 直接报参数错误（两个 `path:` 会 AND 成 0 条） |
| `pathMustExist` | boolean | 可选，缺省 `true`。传 `false` 只表示「容忍这个 scope 可能不存在」，**它本身不再触发全盘回退**——全盘要再加 `allDrives: true` 二次确认。理由：把 scope 丢掉等于搜整个索引（实测漏路径那次命中 **22541** 条），而盘上两套同构插件目录会让结果出双份 |
| `allDrives` | boolean | 可选，全盘回退的二次确认：只在同时传 `pathMustExist: false` 时有意义，也只有那时才真的丢掉 scope，结果头明写 `path ignored: does not exist (...) so this searched the whole index`。单独出现是参数错误（它读起来像「搜全盘」却什么都不做）——真想搜全盘就别传 `path` |
| `maxResults` | number | 单次返回条数，1–500，默认见常量 `DEFAULT_MAX_RESULTS`，文档不写死数字 |
| `offset` | number | 分页起点：接上一条结果里的 `nextOffset` 继续翻页，首页不传（定义原文就这一句）。负数即参数错误、`countOnly` 不许配正 `offset`，都是 `execute` 的判定，由**运行时输出**给出，不进定义 |
| `exclude` | string | `;` 分隔的排除片段，渲染成 `!path:<片段>`；默认 `$RECYCLE.BIN; System Volume Information; WinSxS`，传空串关闭 |
| `sort` | string | 可选，排序字段：`name`/`path`/`size`/`dateModified`/`dateCreated`，其它值报参数错误。白名单在 `execute` 里校验，不走 schema enum（本宿主 DSL 挑食）；**不传按 `name` 升序**——实现里显式写回 SDK 排序值 1（`SetSort` 是进程级状态，不写回就会让上一条查询的排序漏给这一条），所以头部与 `offset` 分页恒按 name 升序解释。**`path` 是读大结果最省的一条**：它是唯一能让同目录文件相邻的排序，因此文本按「目录打一次 + 文件缩进」输出，同一条查询实测省约 50% 字符（500 条 69467 → 34587），且每页首行仍是完整绝对路径、`nextOffset` 分页不受影响。要判断「那里有什么」选 `path`，要判断「谁最大/最新」才选 `size` / `dateModified` |
| `descending` | boolean | 可选，把 `sort` 反序。定义只给两个搭配示例：配 `sort:dateModified` 取最新、配 `sort:size` 取最大；`sort` 缺省时按 `name` 降序属**实现口径**，不在定义里复述 |
| `countOnly` | boolean | 可选，只报匹配总数：`items` 为空数组、`total` 是全集计数，解码整段跳过——先量规模再翻页就用它。与正 `offset` 互斥这条约束归**运行时输出**，定义里只有用途 |
| `type` | string | 可选，`file` 或 `dir`。定义原文只有一句「Keep only files or only folders (file, dir)」；渲染成 `file:`／`folder:`、白名单在 `execute` 里校验、与串内 `file:`／`folder:` 撞车报错，全部由**运行时输出**给出 |

**定义与运行时输出的分工**：工具与参数的 description 只回答「这个参数是干什么的、怎么用」，互斥、非法值、钳位、索引未加载、scope 被丢掉这类**约束一律由运行时输出给出**（报错文案、header 追加句、页脚出路）。所以上表里写的「报参数错误」都是实测行为，不是定义原文——查用法看定义，查约束看输出。

输出字段：`items`（每项 `path`/`folder`/`size`/`mtime`，`mtime` 是整数 epoch 毫秒（FILETIME 换算后取整，分数毫秒过不了宿主的无损 JSON 判定），读不到给 `-1`；文本里每条按 `路径<TAB>大小<TAB>本地时间` 打印，读不到大小或时间都打 `-`（三列恒在，不留连着的 TAB），不印 1970）、`total`（命中总数）、`truncated`、可选 `nextOffset`、`offset`（本页起点，钳后的真实值）、`countOnly`、`dbLoaded`（Everything 索引是否已加载）、`excluded`（本次生效的排除规则条数）、`pathIgnored`（仅当 `pathMustExist: false` + `allDrives: true` 丢掉了一个不存在的 scope 时带上原 scope）、`typeIgnored`（仅当搜索串里已带 `file:`／`folder:`、`type` 因此未追加时带上那个 `type` 值）、`compacted`（仅当 `sort:path` 且有命中时为 `true`，表示文本用了前缀压缩形态；`items` 本身不变，仍是完整绝对路径）。

**`sort:path` 时的文本形态**：目录单独成行、文件缩进四格，跳转用 `..\` 前缀；`..` 的层数等于「上一目录深度 − 共享段数」，所以跨越多层时会写成 `..\..\x` 而不是 `..\x`。三种情况回退成完整绝对路径：每页第一行、换盘符、上跳超过 3 层（更深的跳转点号比省下的前缀还长，且没人能数清）。还原方法就是按行累加：遇绝对路径就替换当前目录，遇相对行就在当前目录上逐段应用 `..` 与后续段——`test/verify.mjs` 用一条独立实现的解析器把这个往返钉成了断言，500 条真实路径还原 500/500。目录变浅时（`C:\a\b` 之后出现 `C:\a` 的文件）会另起一行目录，哪怕它只是 `..\`，否则该文件会被误读成仍在更深的目录里。

header 形态照实写，别去找不存在的句子：截断或 `offset > 0` 时是 `Found N of M results (offset X)`，首页且未截断时是 `Found M results`；`offset` 越过总数时头行追加 `offset N is past the end: total is M`，不再把空页印成全量；`countOnly: true` 时 header 只有 `Found <total> matches (count only)`，`items` 为空数组、`truncated` 恒为 `false`（也就没有 `nextOffset`）。非 countOnly 一律在其下固定再输出一行 `shown N / total M / nextOffset X`（没有下一页时 `nextOffset` 打 `-`），把「这只是采样」写进结构；countOnly 不出这一行。`pathMustExist: false` 丢过 scope 时 header 追加 `path ignored: does not exist (…)`，索引未加载时追加 `index is not loaded yet`。**0 命中**且范围未被改写、索引已加载时，header 追加 `= no match in the index (indexed volumes only)`，并在页脚给出一条放宽的出路 `widen: drop path:, drop ext:, or relax the pattern`（当次有排除规则生效时，再带一句 `exclude:""` 的回头路）——这两句共用一个门控：`countOnly`、索引未加载、`pathIgnored`/`typeIgnored` 非空时一律不出。（`type not appended` 只可能出现在直接调 `buildSearch` 的路径上；工具面遇到 `type` 与串内 `file:`／`folder:` 撞车已改在执行期报参数错误，不再走到头行。）

### `everything_status`（探活，无参数）

回答一件事：`everything_search` 现在能不能用。只读索引加载标志与 SDK 版本，**不发起查询、不解码结果**。输出仅 `ok`/`code`/`message`/`version`/`path`，`additionalProperties: false`。

判决：`EVERYTHING_READY`（能用）、`EVERYTHING_INDEX_NOT_LOADED`（Everything 在但索引未加载）、`STATUS_SKIPPED` / `STATUS_ABORTED`（探活自身没答，不代表引擎 DOWN）。不提供修复步骤——索引不可用时正解是退回 `grep`/`glob`。探测预算钳在 1500–5000ms（探活是诊断不是检索，预算再小也不能把健康引擎报成 DOWN）。

### `anytxt_search` / `anytxt_read` / `anytxt_status` / `anytxt_sync_index`（内容检索，需 Anytxt）

四条工具与 `everything_search` 一样无条件注册，装好即用，没有开关要记。它们走本机 HTTP JSON-RPC（默认 `http://127.0.0.1:9920/rpc`，仅默认端口时才试回退 `9921/rpc`），不绑定任何 DLL，也不经 Everything 的 worker 单例；Anytxt 没开只影响内容检索，`everything_search` 与 `grep` 照旧。

前提：Anytxt（`ATGUI.exe`）在运行，且目标目录已经加进它的索引。`dir` 只做查询过滤，**不建索引**——查一个没被索引的目录返回空，而不是报错；要建库或刷新索引用 `anytxt_sync_index`（见下）。结果是索引里的副本，不是磁盘上的当前文件，所以每次都按 `indexed copy, may be stale` 对待。

`anytxt_search` 的调用参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `pattern` | string | 必填，内容查询词；支持与／或／非。双引号包起来的整句按整句匹配——**引号原样留在 `pattern` 里发给服务端**（实测服务端完全忽略 `st`，整句语义只由引号决定；`st` 仍照发，但无作用）。去掉引号就退化成多个词分别匹配 |
| `dir` | string | 必填，一个已建索引的目录，**也可以是盘根**（`C:\` = 整个 C 盘，`filterDir` 是前缀匹配）；只过滤，不建库（建库/刷新用 `anytxt_sync_index`）。空值直接报参数错误，不猜整盘。分隔符会归一（`/` 与 `\` 等价）——实测正斜杠写法服务端静默回 0 命中 |
| `ext` | string | 可选扩展名过滤，原样进 `filterExt`（缺省 `*`）。多值只认**分号**分隔 |
| `limit` | number | 单次条数 1–300（API v1 的整数区间，越界会被 `-32602` 拒），默认取 `anytxtMaxResults`（20），越界在 `execute` 里钳，下发时传真整数；**钳位会写进结果头**（`limit N is outside 1-300 and was clamped`），不再静默取 1 或全量 |
| `offset` | number | 分页起点，接上一条结果里的 `nextOffset`；钳到 **2^31-1**（`ANYTXT_OFFSET_CAP`）——`GetResult` 只收有符号 32 位整数，实测 `2147483648` 起被 `-32602` 拒，钳位就是为这个；**越过总数**时空页会写明 `offset N is past the end: total is M`（与 `everything_search` 的 FIX-2 同款，不再只回一个空页） |
| `order` | number | 排序：0 默认 / 1 修改时间升 / 2 修改时间降 / 3 路径升 / 4 路径降（五值真机实测，同一查询各回不同文件），其它值报参数错误。白名单在 `execute` 里校验，不走 schema enum（理由同 `everything_search` 的 `sort`／`type`）。与 `offset` 同用时的翻页稳定性未验证——时间序在索引更新时可能错位，长翻页请固定 `order: 0` 或改用路径序 |
| `exclude` | string | `;` 分隔的路径片段，大小写不敏感的**子串**匹配，命中即从这一页的结果里剔除；默认 `$RECYCLE.BIN; System Volume Information; WinSxS`，传空串关闭。生效条数写进结果头（`(3 exclusion rules applied)`），0 条时不印——排除是显式的，不做静默丢结果 |

**参数纪律**：`pattern`／`dir`／`ext`／`limit`／`offset`／`order`／`exclude` 之外的键一律报 `ANYTXT_INVALID_ARGUMENT`，**没有 `countOnly`**（全集条数就是 `total`，页大小由 `limit` 决定）——旧实现会把 `countOnly` 静默忽略却照样列出路径，读起来像「只报了数」。

**运行时输出**（约束跟着结果走，不占常驻 description）：

- 正常页尾：`(indexed copy, enabled types only: an unknown, bitmap or database file carries no text)`；
- 截断页尾：`pass offset N` + 同一条类型边界；
- **0 命中**：页脚明说 `no match in the index - only folders an index was built for are searchable, and only the types Anytxt's index settings enable are extracted`，并给出放宽出路；
- header 的 `(offset X)` 在 `offset > 0` 时**一定出现**——此前只在截断时出现，`total=11 / offset=10` 那一页会印成 `Found 11 results`，读起来像「这就是全部」。

输出：`items`（每项 `ref`、`path`，`size`／`modified` 读不到就整键不写）、`total`、`truncated`、`offset`、可选 `nextOffset`。模型可见文本里每行是 `ref<TAB>路径<TAB>大小<TAB>本地时间`——**`ref` 是第一列**，也是拿到 `anytxt_read` 所需 id 的唯一途径（fid 无法从路径推导）；大小与时间读不到打 `-`，`ref` 那一列恒在。header 固定带一句 `indexed copy, may be stale`；默认三条排除见 `exclude` 参数，生效条数写成 `(N exclusion rules applied)`。翻页口径与 `everything_search` 一致，但 `nextOffset` 按**服务器原始返回行数**推进（不是过滤后条数）：实测 `GetResult` 的窗口随 `offset` 1:1 滑动，用过滤后条数起头会覆盖原始页尾、把没被排除的行重复发出来。

`anytxt_read` 的调用参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `ref` | string | 必填，`anytxt:` 前缀的引用，只能来自 `anytxt_search`；别家前缀直接报参数错误。索引里没有该 fid 时报 `ANYTXT_FID_NOT_FOUND`（不是「空文档」） |
| `mode` | string | `fragments` 或 `full`，缺省 `full`；其它值报参数错误 |
| `query` | string | 仅 `fragments` 必填：要高亮片段的关键词 |
| `offset` | number | 仅 `full`：字符偏移，不是页码 |
| `max` | number | `fragments` 段数 1–8（默认 8，服务端上限就是 8：`limit` 被忽略，传多少都回 8 段）；`full` 字符数 1–40000（默认 8000） |

互斥在 `execute` 里显式判，一律 `ANYTXT_INVALID_ARGUMENT`：非法 `mode`、`fragments` 缺 `query`、`fragments` 传了 `offset`、`full` 传了 `query`（`max` 两种模式都收：`fragments` 是段数，`full` 是字符数）。不靠 schema 拦——本宿主的值 DSL 不收 `oneOf`／`enum`，写进去整条工具会被丢掉。输出：`fragments` 给 `snippets`／`totalSnippets`；`full` 给 `text`／`totalChars`／`returned`／`offset`／`truncated`。

**运行时输出**：`fragments` 的页脚固定带 `(at most 8 passages exist; Anytxt passages can read backwards in Chinese - switch to mode full when one does)`；`full` 被截断时页脚直接给 `(continue with offset N)`，调用方不必自己算 `offset + returned`。`totalChars` 是整篇抽取文本的长度，`returned` 是本次实际带回来多少。

> ⚠️ `full` 模式的传输量没有上限：`GetRawTextByFID` 忽略 `offset`／`limit`（回显只有 `{fid}`，实测一个文件直接回 1,219,343 字符），整篇抽取文本每次调用都会传过来、`max`／`offset` 只裁返回窗口。所以大文档翻页是每页重下全文，峰值内存是 O(文档) 而不是 O(max)——先用 `fragments` 判断值不值得读，再取全文。

`anytxt_status`：无参数，输出仅 `ok`／`code`／`message`／`url`（`additionalProperties: false`）。只答「内容索引现在能不能用」，内部 `state` 不外露，也不写 `version`（Anytxt 的 RPC 没有版本方法）。三态：`ANYTXT_READY`（服务端对 Search 有应答即判可用——0 命中只作附注，因为一次探针分不出「索引为空」和「索引里没有这个词」）、`ANYTXT_MISSING_TOOL`、`ANYTXT_DOWN`，探活永不抛。`ANYTXT_INDEX_NOT_LOADED` 保留在码表里但不再产出；索引是否真的为空由真正的搜索回答（空结果 + `indexed copy, may be stale`）。

**运行时输出**：渲染末尾固定追加一行 `(content index only: when this is down, everything_search and grep stay usable)`——`ok: false` 只说明内容面不可用，最容易被读成整台机器不可用。

`anytxt_sync_index`（按目录建库，插件里唯一会改索引状态的一步）

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `folder` | string | 必填，绝对 Windows 目录。无盘符的路径（相对路径、根相对路径）与不存在的目录一律当场报参数错误——实测这两种服务端都回 `errno 0` 却什么都不建，所以都在插件侧拦，不靠服务端。**正斜杠不报错**：先归一成反斜杠再建库（`C:/Users/x` 与 `C:\Users\x` 等价），因为原始正斜杠正是那个「回 `errno 0` 却什么都不建」的实测形态 |

输出：`folder`（归一成反斜杠后的路径）、`ok`、`code`、`message`。回 `ok` 只表示「请求已被接受」，建库在后台跑，通常数秒后 `anytxt_search` 就能搜到——确认方式就是再搜一次。删除、移动、重命名一概没有绑定。

**运行时输出**：渲染末尾固定追加 `(accepted, not ready - building runs in the background, so confirm with anytxt_search after a few seconds; only the types Anytxt's index settings enable get text, so an unknown, bitmap or database file is accepted with zero text and never matches)`——「建库被接受」与「只有启用类型才有文本」这两条只在真建库时才需要看。

## 💬 提示词说明

插件在加载时向宿主注入**两段 system prompt**，各由对应组件行注册——关掉哪条行，哪段提示词随之消失（order 取值集中在 `lib/shared/prompt-orders.mjs`，一行一个数、全局唯一，不许用 `+1` 凑顺序）。

**第一段**：`name: tool:everything_search`，`order: 3254`，由文件名面注册（`lib/components/everything/index.js`）：

```
Before work: one everything_search first — find what the machine already has for this task.
Mid-task: something missing? search first, then guess, ask, or stub.
Use: everything_search for whole-disk discovery by name — contents are grep's, in-workspace paths are glob's. Index up? ask everything_status; an empty result still means fall back to grep/glob.
Argument rules live in the tool and parameter descriptions.
Report in three steps: header, paths verified with read or glob, paging; unverified paths stay "candidate, unverified".
```

**第二段**：`name: tool:anytxt_search`，`order: 3255`，由内容面注册（`lib/components/anytxt/index.js`）：

```
Use: anytxt_search for text inside indexed folders' enabled types (PDF/DOCX/XLSX/PPTX/EPUB, Office, source); everything_search finds names, grep reads one known file.
Hits describe the indexed copy and may be stale; dir only filters; bitmaps, databases and unknown types carry no text.
Read back with anytxt_read (fragments or full); Chinese fragments can run backwards - use full.
```

**为什么只写这些**：prompt 只承载两件事——「要不要调这个工具」（用途与三者的分工）和「怎么汇报」（跨轮行为纪律，比如未核验路径要标成「候选，未核验」）。语法要点与 `regex:` 的引号形态归**工具 description 与各参数 description**（那两份每轮都在上下文里，prompt 再抄一遍就是同一句话占两处字符）；而**互斥、非法值、钳位、索引未加载这些约束不进任何一处静态文本，只由运行时输出给出**——静态文本复述约束，改实现时最容易只剩文案没跟上，定义也会越写越像错误码手册。栈的边界也写进 prompt——按名找文件归 `everything_search`，已知文件精读归 `grep`，`glob` 管工作区内路径匹配（prompt 不再声称「工作区源码归 grep」：索引设置启用源码类型后，那句话会让模型主动放弃已经建好的能力）。

**边界与上限不进 prompt**：`anytxt_*` 的类型边界、`accepted ≠ ready`、片段上限与中文倒序、续读句柄、探活口径，全部写在**每次的结果里**（见各工具的「运行时输出」），与 `everything_search` 把 `path ignored` / 零命中出路写进 header 是同一做法。

宿主如果没有 `systemPrompt.section`（唯一软探测项），只记一条 warn，**工具照常注册**，只是少了这两段引导。

## ⚙️ 配置

配置必须写在**组件行**上，写在外壳行无效：外壳 `apply()` 只做「探测宿主能力 → 组 caps」，不注册任何工具、也不向组件传 caps（实测外壳行配 `maxResults`/`timeoutMs` 得到 `{ tools: [], promptSections: [] }`，同一份值写在组件行才进 description）。两个行 id 原文：

- `dsh-tool-everything-everything` —— `maxResults`、`timeoutMs`、`everythingDllPath`、`autoStart`
- `dsh-tool-everything-anytxt` —— `anytxtUrl`、`anytxtTimeoutMs`、`anytxtMaxResults`、`anytxtSyncTimeoutMs`

缺键一律取默认，坏值（非整数、越界）回退默认——不会以一条无错误码的裸 `RangeError` 逃出。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxResults` | 见 `lib/index.js` 的 `DEFAULT_MAX_RESULTS` 常量 | 单次返回结果上限（硬上限 500，超出在 `execute` 里 clamp 到 1–500）。宽查询的大结果按字节触发 spill 落盘，够判断方向，不够就收窄重搜 |
| `timeoutMs` | `8000` | 工具超时预算（ms）；FFI 查询阻塞不可中断，故预算偏短 |
| `everythingDllPath` | 包内 `native/` | 自定义 Everything64.dll 路径（一般不用） |
| `autoStart` | `false` | 索引未加载时是否替你拉一次 `Everything.exe -startup`、等 ≤3s 并重试一次；默认关，不替用户启动进程 |
| `anytxtUrl` | `http://127.0.0.1:9920/rpc` | Anytxt JSON-RPC 端点，必须是 loopback。`/rpc` 是 ATGUI 的 RPC 路径（根路径是帮助网页，POST 过去回 404，实测 `POST /` → 404、`POST /rpc` → `errno:0`）；只给 origin 时插件自动补 `/rpc`。只有地址用默认端口时才回退 `9921`，且只换端口不换路径 |
| `anytxtTimeoutMs` | `15000` | 正文检索单次请求预算（ms），上限同 `timeoutMs` 的 `MAX_TIMER_DELAY_MS` |
| `anytxtMaxResults` | `20` | `anytxt_search` 的默认单页条数（硬上限 300，与 API v1 的 `limit` 整数区间一致） |
| `anytxtSyncTimeoutMs` | `60000` | `anytxt_sync_index` 的单次预算（ms）。建库比查询慢（小目录实测 6 秒内完成，大目录未知），故与查询的 15 秒分开 |

## 🧪 验证

回归检查在仓库里：`npm run verify`（`test/verify.mjs`；依赖 Everything 在跑的项在它未启动时打 `SKIP`，退出码仍为 0）。`VERIFY_REQUIRE_LIVE=1` 时 `SKIP` 计为失败（退出码非 0），用于「live 必须真跑」的回归。

内容面另有一整套：`npm run anytxt:verify`（`test/anytxt.verify.mjs`，全套离线，靠注入 `fetchImpl` 走完四态与每个 `ANYTXT_*` 码）。两套一起跑用 **`npm run verify:all`**——旧版没有聚合脚本，只跑 `verify` 会让那 60+ 条 anytxt 断言**永远不跑**。

`verify.mjs` 除了跑行为断言，还把文档钉在代码上：README 必须登记编译出的全部参数、三句 header 形态、实测常量那一批数，以及 `lib/` 里出现的**每一个错误码字面量**——改了代码不更文档会直接红。

## ❌ 错误码

| code | 含义 |
| --- | --- |
| `EVERYTHING_SDK_LOAD_FAILED` | 找不到或无法加载 `Everything64.dll` |
| `EVERYTHING_NOT_RUNNING` | Everything 未运行 |
| `EVERYTHING_OUT_OF_MEMORY` | Everything SDK 报内存不足（`lastError=1`） |
| `EVERYTHING_REGISTER_CLASS_FAILED` | Everything 无法注册其 IPC 窗口类（`lastError=3`） |
| `EVERYTHING_CREATE_WINDOW_FAILED` | Everything 无法创建 IPC 窗口（`lastError=4`） |
| `EVERYTHING_CREATE_THREAD_FAILED` | Everything 无法创建 IPC 线程（`lastError=5`） |
| `EVERYTHING_INVALID_INDEX` | 取结果的索引越界（`lastError=6`） |
| `EVERYTHING_INVALID_CALL` | SDK 在非法状态下被调用（`lastError=7`） |
| `EVERYTHING_INVALID_REQUEST` | Everything 拒绝了这条 IPC 请求（`lastError=8`） |
| `EVERYTHING_INVALID_PARAMETER` | 查询参数被 Everything 拒绝（`lastError=9`） |
| `EVERYTHING_ERROR_0` | 报了失败却没置错误码，通常索引未就绪（码表从 1 起，0 单独解释，见下表注） |
| `SEARCH_ABORTED` | 工具被超时/用户取消终止 |
| `EVERYTHING_QUERY_FAILED` | worker 回了失败但没带具体 code 时的兜底 code |
| `EVERYTHING_WORKER_FAILED` | worker 内部抛错（错误分支与启动失败同码） |
| `EVERYTHING_WORKER_EXITED` | worker 在回答前退出；下一次调用会新建一个 |
| `EVERYTHING_WORKER_REPLACED` | `apply()` 重载换掉旧 worker，被中断的那条请求以此码结束 |
| `EVERYTHING_QUERY_TIMEOUT` | 看门狗超时（早于宿主的工具预算）。原生查询无法取消，所以 `SIGKILL` 掉承载它的**子进程**，让 SDK 的进程级查询锁随进程一起消失，下一次调用起一个干净的子进程。宿主超时时**不会**触发 `exec.signal`（实测），所以只有这条看门狗能保证释放 |
| `EVERYTHING_QUERY_POISONED` | 连续两次看门狗超时后运行时报废：杀掉子进程仍未释放锁。此后每次调用立刻失败，恢复方式是重启 DSH 服务进程——**重载插件无效**（实测：完整卸载+重载后仍超时） |
| `EVERYTHING_READY` | `everything_status` 的判决：索引已加载，搜索可用（`ok: true`） |
| `EVERYTHING_INDEX_NOT_LOADED` | `everything_status` 的判决：Everything 在应答，但索引尚未加载，搜索答不了 |
| `STATUS_SKIPPED` | `everything_status` 的探活自身没在预算内答；不代表引擎 DOWN |
| `STATUS_ABORTED` | `everything_status` 的探活被取消；不代表引擎 DOWN |
| `ANYTXT_READY` | `anytxt_status` 的判决：Anytxt 索引应答了，内容检索可用（`ok: true`） |
| `ANYTXT_INDEX_NOT_LOADED` | **保留码，不再产出**：一次探针的 0 命中分不出「索引为空」与「索引里没有这个词」，据此判 `ok:false` 会把可用索引报成不可用。索引是否真的为空由真正的搜索回答（空结果 + `indexed copy, may be stale`） |
| `ANYTXT_MISSING_TOOL` | 找不到 `ATGUI.exe` 且端点不应答，看起来没装 Anytxt |
| `ANYTXT_DOWN` | Anytxt 的 JSON-RPC 端点连不上（消息里带 `ECONNREFUSED` 这类原因码） |
| `ANYTXT_TIMEOUT` | Anytxt 请求超过预算没答 |
| `ANYTXT_ABORTED` | Anytxt 请求被取消（工具超时或调用方取消） |
| `ANYTXT_HTTP` | Anytxt 端点回了非 2xx |
| `ANYTXT_RPC` | Anytxt 拒绝了这条 JSON-RPC 调用，或回包里没有 `result.data.output` |
| `ANYTXT_BAD_OUTPUT` | Anytxt 回的不是期望的 JSON 对象 |
| `ANYTXT_ENDPOINT_REMOTE` | 配置的 Anytxt 地址不是本机回环地址 |
| `ANYTXT_INVALID_ARGUMENT` | anytxt 三工具的参数在发出请求前就被拒（`mode` 非法、`fragments` 缺 `query`、`dir` 为空、`ref` 的 id 不是数字、`exclude` 之外的可选值非法等） |
| `ANYTXT_FID_NOT_FOUND` | `anytxt_read` 的 `ref` 指向索引里不存在的 fid（实测服务端回 `errno 1` + `text: null`）：`ref` 过期、来自别的机器，或索引重建过。重搜一次拿新 `ref`——不要把它读成「空文档」 |
| `ANYTXT_SYNC_ACCEPTED` | `anytxt_sync_index` 的写路径回执：请求已被服务端接受，建库在后台跑。刻意不借 `ANYTXT_READY`——那个码是 `anytxt_status` 的判决，混用会让一次写路径的结果读起来像一次探活判决 |
| `INVALID_REGEX` | `regex:` 子句明显写坏（括号或字符类未闭合） |
| `E_TYPE_AMBIGUOUS` | 类型断言出现两个来源：参数 `type` 与搜索串里的 `file:`／`folder:` 宏同现，或两个宏同现。两者 AND 起来恒为 0 条，所以是参数错误而不是空结果；消息里带 `hints.rewrite`（保留参数、删宏）与 `hints.alternative`（保留宏、删参数）两条可直接执行的改写 |
| `E_TYPE_CONFLICT` | 类型断言互相排斥：`folder:` 或 `type: dir` 撞上 `ext:`／`*.ext` 通配。文件夹不可能是某种文件，任何磁盘状态下都是 0 条——`ext:` 本身已经隐含了「这是文件」的类型断言 |
| `E_CONTENT_TYPE_CONFLICT` | `content:` 撞上「只留目录」的类型断言：串内正向 `folder:`，或参数 `type: "dir"`（`buildSearch` 把它渲染成 `folder:`）。正文只存在于文件里，目录没有正文，所以两者 AND 起来在任何磁盘状态下都是 0 条——实测同 scope 下 `folder:docs content:"KEY"` 6 ms 回 0（一个文件都没读），换 `path:docs` 写法要 224 ms 才真扫。旧行为静默归零，调用方把它读成「这个目录里没有」。`file:` 与 `!folder:`／`!file:` 不触发（前者恒为真、后两者是排除）。消息里带 `hints.rewrite`（只摘掉类型词，保留正文过滤器） |
| `E_TYPE_INLINE` | 把 `type:dir`／`type:file` 写进了 `search` 串。`type` 是本工具的独立参数，Everything 没有原生 `type:` 函数，所以那几个字只会被当成字面文件名去匹配，实测 `node_modules type:dir` 回 0 条——参数用错被读成「磁盘上没有」。消息里带 `hints.rewrite`（`{ type, search }`，已把串内 `type:` 摘掉；摘空则落 `*`）。刻意不做自动纠错：静默转换会让真的存在一个叫 `type:dir` 的文件时永远搜不到 |
| `E_TYPE_BAD_VALUE` | 串内写了 `type:` 但取值既不是 `dir` 也不是 `file`。类型过滤器只有这两个取值，其余值什么类型都不断言，词本身仍会被当字面量匹配，恒为 0 条 |
| `E_SORT_INLINE` | 把 `sort:size` 之类写进了 `search`。`sort:` 是 Everything 的原生排序函数，它不参与过滤、只改顺序，且 `SetSort` 是进程级全局状态，于是串内这一项会静默盖掉 `sort`／`descending` 参数——实测条数与路径全对、只有顺序错。归零看得见，错序看不见，所以单独报码。消息里带 `hints.rewrite`（已摘掉串内 `sort:`） |
| `E_SORT_AMBIGUOUS` | `sort:` 同时出现在 `search` 与 `sort`／`descending` 参数里。两个来源争同一个进程级全局状态，谁后落谁生效、另一个被静默忽略，所以是参数错误而不是「按参数排序」 |
| `E_PARAM_INLINE` | 把本工具其余参数名（`offset:`、`maxResults:`、`countOnly:`、`descending:`、`exclude:`、`allDrives:`、`pathMustExist:`）写进了 `search`。它们不是 Everything 的函数，只会被当成字面查询词参与 AND——实测 `node_modules descending:true` 从 463 条变 0 条 |
| `E_SCOPE_DROPPED` | `path` 参数指向不存在的目录。默认直接报错（`pathMustExist` 缺省为 true）；只有显式 `pathMustExist: false` 加 `allDrives: true` 才丢掉 scope 并搜整个索引，此时结果头写明 `path ignored: does not exist` 且明说这些结果不来自那个目录 |
| `EVERYTHING_ERROR_<n>` | 映射表外的 SDK 错误码，原样透出数值（例如 `EVERYTHING_ERROR_99`） |
| `HOST_CAPABILITY_MISSING` | 宿主缺少本插件注册所需的接口（消息点名能力名、使用它的函数名与期望/实际） |
| `HOST_MISSING_SIGNAL` | 工具调用上下文没带可用的 `exec.signal`（`aborted` 非布尔），超时/取消判断失效 |
| `HOST_PROBE` | 宿主自检探针：`probeHost` 里造的探针错误，只验证 `HarnessError` 可继承且带 `code`，不外露 |

> 映射表从 `lastError=1` 起：`lastError=0`（SDK 定义里的 `EVERYTHING_OK`）本工具不走，它在这种语境下是「报了失败却没置错误码，通常索引未就绪」，单独报成 `EVERYTHING_ERROR_0`。

## 🔎 Anytxt 实测口径（真机探针，非文档抄录）

四条与官方文档或直觉不符，全部实测（`anytxt.v1.*`，`127.0.0.1:9920`）：

- `st`（精确／高级模式）被服务端**完全忽略**：它从不出现在回显的 `input` 里，而所有真实生效的参数（`pattern`/`filterDir`/`filterExt`/`lastModify*`/`limit`/`offset`/`order`）都在。整句语义只由 `pattern` 内的双引号决定——同一词组带引号 15 条、裸词 69 条；`st` 传 1／传 2／不传，命中数一模一样。旧实现「剥掉引号 + 设 `st=1`」正好删掉了唯一生效的那个信号。
- `filterExt` 多值只认**分号**：`pdf;docx` 命中 7 条；`pdf,docx` 命中 0 条，服务端不报错，静默归零。
- `getFragmentAll` 的 `limit`／`topK` **无效**：传 3 恒返 8 段、回显恒 `limit: 8`，段数只能在客户端切，且只能往下切（本插件按实测把对外上限记作 1–8，不再宣称 32）。
- `filterExt: "md"` 命中 22720 条、接近全量（`txt` 只有 4467 条），行为异常，**未验证**，不得据它推断扩展名语义。

同批实测另两条：服务只绑回环（非回环 Host/Origin 直接 `403`），请求体上限 1 MiB；结果描述的是索引里的副本，不是磁盘当前文件。

## 📐 调用原则与约束

与当前工具 description 的五段（Usage / Principle / Semantics / Report / Scope）对齐；下面多出的「约束」一段**不进定义**，只作为运行时输出的判据：

- **用途**：全盘按文件名查找，从精确匹配逐步放宽到通配符。
- **原则**：一次查询一个意图；顺序为精确名 → `path:`／`ext:`／`size:` → 裸通配符。非 countOnly 结果附 `shown N / total M / nextOffset X` 一行，头部为 `Found M results`（全集）或 `Found N of M results (offset X)`（截断）；翻页用 `nextOffset`，不靠增大 `maxResults`。
- **约束（运行时输出，不进定义）**：0 结果 = 索引中无，不写作「文件不存在」；头部提示索引未加载或 `dbLoaded: false` 时空结果不确定（问 `everything_status`；搜索本身不探活）；`<DIR>` 是目录，不读取；`countOnly` 不与正数 `offset` 同传；`path` 缺失报最近存在的父目录；全盘回退要 `pathMustExist: false` + `allDrives: true` 两次确认——只写 `false` 是参数错误，不会静默放大到全盘。
- **语义**：`maxResults` 的默认值与上限见参数表（由常量决定，不写死数字）；`type: file` → `file:`、`type: dir` → `folder:`；不传 `sort` 且 `descending: true` 即 name descending，不被忽略；`regex:` 支持双引号形态承载空格（如 `regex:"final report"`）；`mtime` 为整数 epoch 毫秒。
- **报告**：原样引用头部 → 已核验路径 → 翻页方式；未核验或仅见于抽样的路径标为「候选，未核验」，不得以单次抽样的条数断言全盘命中数量。
- **范围**：默认排除 `$RECYCLE.BIN`、`System Volume Information`、`WinSxS`；传 `exclude:""` 可包含它们。

## 🧩 技术细节

```
┌─────────────────────────────────────────────┐
│  DSH Agent (你)                              │
│  调用 everything_search("npm", max=10)       │
├─────────────────────────────────────────────┤
│  dsh-tool-everything (本插件)                │
│  koffi FFI → Everything64.dll               │
├─────────────────────────────────────────────┤
│  Everything SDK (IPC 通道)                   │
├─────────────────────────────────────────────┤
│  Everything.exe (全盘 NTFS 索引引擎)         │
└─────────────────────────────────────────────┘
```

- `Everything64.dll` 来自 [Everything SDK 1.5](https://www.voidtools.com/Everything-SDK.zip)；Anytxt 侧只走 `127.0.0.1:9920` 的 JSON-RPC，不绑任何 DLL
- FFI 通过 [koffi](https://koffi.dev) 实现（本包 `dependencies` 里的 `koffi`）；绑定与实测常量集中在 `lib/components/everything/sdk.mjs`，主线程与 worker 共用一份（两份必漂）
- **查询跑在 worker 线程**（`lib/components/everything/query-worker.mjs`）：`Everything_QueryW` 是阻塞调用，搬进 worker 后事件循环不再被它卡住；主线程只保留单在途链条，5 条并发不会同时塞进 DLL（并发是排队不是并行：一次只放一条进 worker，按 request id 的真并发还没做）
- **在途原生查询不可取消**（实测，不是推断）：`worker.terminate()` 在 `Everything_QueryW` 在途时返回只要 6–8 ms，但线程是在原生调用返回之后才真正退出——terminate 之后它还会补发一条结果。所以 abort 的处理是「换新 worker、丢掉旧回复」，不宣称能打断已在 DLL 里的调用
- 插件 ESM 模块（外壳 `lib/index.js` + 两条组件行 `lib/components/everything/`、`lib/components/anytxt/` + 共享件 `lib/shared/`），Cordis 插件规范
- **兼容性靠能力检测，不靠版本区间**：`engines.dsh` 与各条 DSH
  `peerDependencies` 同声明 `>=0.2.0-rc.1 <1.0.0`，只作安装期兜底提示。插件
  `apply()` 开头调用 `probeHost(ctx)`，逐项探测真正用到的宿主接口，缺一项即抛
  `HOST_CAPABILITY_MISSING`，消息点名能力名 + 使用它的函数名 + 期望/实际，不写「版本不匹配」，
  也不写行号（行号每改一次就漂一次，写死等于埋新坑）
- 探测项：`defineTool` 为函数、`HarnessError` 可继承且带 `code`、
  `MAX_TIMER_DELAY_MS` 为正有限数、schemastery 默认值填充真的生效、
  `ctx.tools.register` 为函数、`defineTool` 接受现定义形（`parameters` + `output.schema` + `output.render`，返回对象含 `execute`——实测缺 `output.render` 会被 `defineTool` 直接拒）；
  `ctx.systemPrompt.section` 是唯一软项——缺了只记一条 warn，工具照注册
- 首次 `execute` 另做一次性探针：`exec.signal.aborted` 必须是布尔，缺则抛
  `HOST_MISSING_SIGNAL`（只查一次，此后不再重复）

### 开发者备注：SDK 常量一律实测，不要按文档手抄

仓库里只有 `native/Everything64.dll`，没有 SDK 头文件。下面这批绑定——`SORT_VALUES`（五档）与 `SORT_DESCENDING_OFFSET`、`REQUEST_FLAG_FULL_PATH` / `REQUEST_FLAG_SIZE` / `REQUEST_FLAG_DATE_MODIFIED` 及其合起来的 `84`、`FILETIME_EPOCH_OFFSET_MS`——是在本机用这份 DLL 实测钉死的，`test/verify.mjs` 有断言兜着；改这些绑定前先跑一遍 verify：

- **`Everything_SetSort` 降序 = 升序 +1，不是 +100**。实测 `name` 升序 `1` 与降序
  `2`：升序尾页与降序首页互为反序；换成 `101` 拿回的还是升序。SORT 表为
  `name 1` / `path 3` / `size 5` / `dateModified 13` / `dateCreated 15`，降序走
  `SORT_DESCENDING_OFFSET` 常量偏移，不手抄成第二张表。
- **`Everything_SetRequestFlags`**：`FULL_PATH = 4`、`SIZE = 16`、`DATE_MODIFIED = 64`。
  flags 必须凑齐 **84**（`4|16|64`）才读得回路径、size、mtime——只设 `16|64` 时
  `Everything_GetResultFullPathNameW` 全部返回空串，只设其一则另一个读回 `-1`。
  每一处读回都与它的 flag 成对，`countOnly` 一个都不设、一条都不解码。
- **`SetSort` 是进程级查询状态**：一次带排序的查询会漏给下一次（实测 `SetSort(5)`
  之后不传排序的查询仍是 size 升序）。所以未传 `sort` 时显式设回 `name` 升序
  （Everything 默认序），「不传新参数时行为与旧版一致」才成立。
- **FILETIME → epoch 毫秒**：`Math.round(Number(koffi.decode(buf,"int64")) / 10000) - 11644473600000`（必须取整：一个 tick 是 100 ns，不取整就是分数毫秒，宿主会判 value is not lossless JSON），
  对应常量 `FILETIME_EPOCH_OFFSET_MS`；`GetResultDateModified` 与 `DATE_MODIFIED`
  必须成对，缺则读回全 `0`/`-1`。

### Anytxt 侧的两条实测常量

- **读 fid 不存在的文档回 `errno 1`**（有效 fid 回 `errno 0`），`text` 为 `null`——`anytxt_read` 靠这条区分「没有这个 fid」与「空文档」；`GetFragmentAll` 两种都回 `errno 0`，分不出。
- **`GetResult` 的 `offset` 窗口 1:1 滑动**（实测 offset 0/1/3 得到错开一行的三页），所以翻页必须按原始行数前进。

## 🧭 设计边界

- **Everything 侧只读**：`everything_search` 与只读探活 `everything_status`，SDK 侧只绑定 `Everything_Set*`、`Everything_QueryW`、`Everything_Get*`，没有写、删、移动、同步、OCR 的入口。内容面另有四条 `anytxt_*` 工具，其中**唯一会改索引状态的是 `anytxt_sync_index`**（对用户显式给出的绝对目录建库，只增不改，不删不移），其余三条只读；工作区路径匹配归 `glob`。
- **不替你起进程**：`autoStart` 默认 `false`。
- **在途查询不可取消**（实测）：`worker.terminate()` 在原生调用在途时 6–8ms 返回，但线程要等调用返回才真退，并会补发一条回复；所以 abort 是「换新 worker、丢掉旧回复」。
- **错误码分三层**：SDK 层（索引不可用 → 退回 `grep`/`glob`）、worker 与取消层（重试）、宿主能力层（装或升级 DSH）。
- **默认排除是显式的**：回收站、系统卷信息、WinSxS 三条默认规则会写进结果头，不做静默丢结果。

完整理由、数据流与只读边界见 [docs/architecture.md](docs/architecture.md)。

## 🔀 本 fork 相对上游的差异

本仓库 fork 自 [roxyyn0304/dsh-tool-everything](https://github.com/roxyyn0304/dsh-tool-everything) 的 `0.4.14`。
上游的架构分层、实测常量（SDK sort/flag/FILETIME 那批）、只读边界与工具分工**一律保留**，本 fork 只做修复、测试与文档同步：

| 面 | 相对上游的改动 |
| --- | --- |
| 内容面（`anytxt_*`） | 命中行渲染 `ref`（在此之前 `anytxt_read` 拿不到入口）；引号整句真正生效（上游剥掉引号后整句退化成多词）；`dir` 统一分隔符（上游正斜杠写法静默 0 命中）；`offset` 上限改为 2^31-1（上游沿用了 Everything 的 uint32，越界被服务端拒后报成后端故障）；默认排除写进结果头并可用 `exclude: ""` 关闭；`nextOffset` 改按服务器**原始行数**前进（上游用过滤后条数，会重复发未排除的行）；`anytxt_status` 不再把「探针 0 命中」判成索引不可用；`anytxt_read` 对不存在的 fid 报 `ANYTXT_FID_NOT_FOUND`（上游静默返回 `0 of 0 characters`）；`modified` 列改**本地时间**（上游印 UTC 墙钟，与 Everything 那列差一个时区） |
| 文件名面（`everything_*`） | 只有一处：`path` 与搜索串里已有的 `path:` 撞车，从静默丢弃改为报参数错误。不传这两个参数时行为与上游一致 |
| 配置 | `cordis.patch.yml` 的 `config:` 从外壳行移到两条组件行——外壳行只做能力探测、不注册工具，写在那里不生效 |
| 健壮性 | `autoStart` 的候选 exe 列表改为按存在性依次尝试（上游实际只试第一个）；组件行入口补整数/范围校验，坏预算不再以裸 `RangeError` 逃出 |
| 测试与文档 | 新增 `test/anytxt.verify.mjs`（全套离线，注入 `fetchImpl` 走完四态与每个 `ANYTXT_*` 码）与 `npm run verify:all`；补齐 README/`docs/architecture.md` 里重构后残留的陈旧标识符 |

逐条理由与验收见上文「0.4.14 → 0.5.0 的破坏性变更」与「0.5.1 修复」两节。

## 📄 License

MIT。**原始版权归原作者 [roxyyn0304](https://github.com/roxyyn0304/dsh-tool-everything) 所有**；
上游 [LICENSE](LICENSE) 原文保留、未做任何改动，本 fork 自身的修改同样以 MIT 发布。

## 🙏 致谢

- [roxyyn0304](https://github.com/roxyyn0304/dsh-tool-everything) — **本插件的原作者**，本 fork 基于他的 `0.4.14`
- [voidtools](https://www.voidtools.com) — Everything 文件搜索引擎
- [koffi](https://koffi.dev) — Node.js FFI 库
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — DSH Agent 框架

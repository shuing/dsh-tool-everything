/**
 * @module lib/shared/config.mjs
 *
 * 一份 Config：外壳与两条组件行共用同一个 schema 对象，谁都不许各复制一套。
 *
 * 数值在这里写成字面量，是因为组件导入本文件、本文件不能再反向导入组件（会成环）。
 * `test/verify.mjs` 有一条断言把这里的默认值与各组件的导出常量对齐，漂了就红。
 */
import z from "@deepseek-ai/schemastery";

/**
 * `.volatile()` 不是缓存提示，而是「这一项能不能在界面上热改」的声明：宿主
 * `dsh-settings` 的 `volatileForm()` 只保留 `schema.meta.volatile` 为真的字段，
 * `describe()` 据此产出配置表单；没有这个标记的行在「插件」页里拿到的 `form` 是
 * `undefined`。所以凡是希望用户在 UI 里调的字段，必须显式标上（宿主自己的
 * `maxParallelToolCalls` / `timeoutMs` 也是这么写的）。
 *
 * 只标三个「改了就下一跳生效、不需要重建实例」的数字；`everythingDllPath`
 * 这类改完要重载进程的字段不标，免得界面给出一个假的“立即生效”。
 */
export const Config = z.object({
	maxResults: z.number().default(100).volatile(),
	timeoutMs: z.number().default(8e3).volatile(),
	// 同一实例上允许同时在途的查询数。默认 1 = 与「单在途链」时代逐字等价；>1 时每条
	// 在途查询各占一个 node 子进程（各自一个 Everything64.dll 实例），所以调大是拿内存
	// 与磁盘寻道换吞吐，只在「多条互不相关的查询」上才有收益。
	concurrency: z.number().default(1).volatile(),
	everythingDllPath: z.string(),
	// Off by default: the tool does not start a process on the user's behalf.
	autoStart: z.boolean().default(false),
	// Content search registers unconditionally, like the Everything tools: the
	// Anytxt index needs its GUI running, but a stopped GUI costs content search
	// only (anytxt_status says why), so there is no switch to remember.
	anytxtUrl: z.string().default("http://127.0.0.1:9920/rpc"),
	anytxtTimeoutMs: z.number().default(15000),
	anytxtMaxResults: z.number().default(20),
	// Building an index is much slower than a query, so it gets its own budget.
	anytxtSyncTimeoutMs: z.number().default(60000)
});

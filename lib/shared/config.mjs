/**
 * @module lib/shared/config.mjs
 *
 * 一份 Config：外壳与两条组件行共用同一个 schema 对象，谁都不许各复制一套。
 *
 * 数值在这里写成字面量，是因为组件导入本文件、本文件不能再反向导入组件（会成环）。
 * `test/verify.mjs` 有一条断言把这里的默认值与各组件的导出常量对齐，漂了就红。
 */
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
	maxResults: z.number().default(100),
	timeoutMs: z.number().default(8e3),
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

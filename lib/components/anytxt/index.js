/**
 * @module dsh-tool-everything/anytxt
 *
 * 内容面组件：`anytxt_search` / `anytxt_read` / `anytxt_status` / `anytxt_sync_index` 的注册面，
 * 加 `anytxt.mjs` 的 JSON-RPC 客户端。
 *
 * 与文件面零交叉 import：本模块不引 `sdk.mjs`、不起 worker、不碰任何 query runtime 状态。
 * `caps` 由外壳组装后传入，配置校验与 `Config` 归外壳。`formatSize` 属包本体
 * （`shared/format.mjs`），跨组件引用允许，绝不复制一份。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	ANYTXT_DEFAULT_LIMIT,
	ANYTXT_MAX_LIMIT,
	ANYTXT_ORDER_VALUES,
	ANYTXT_RPC_TIMEOUT_MS,
	DEFAULT_ANYTXT_SYNC_TIMEOUT_MS,
	DEFAULT_ANYTXT_URL,
	DEFAULT_EXCLUDE_FRAGMENTS,
	getFragments,
	getRawText,
	invalidArgument,
	parseAnytxtOrder,
	probe as probeAnytxt,
	searchContent,
	syncIndex
} from "./anytxt.mjs";
import { formatSize, formatLocalStamp } from "../../shared/format.mjs";
import { resolveBudgetMs } from "../../shared/limits.mjs";
import { PROMPT_ORDERS } from "../../shared/prompt-orders.mjs";
import { Config } from "../../shared/config.mjs";

/**
 * The model-facing text of one `anytxt_search` page: the counts first, then one
 * line per hit, then the freshness note. The note is not decoration - the
 * content index is a separate copy of the disk, so a stale hit is the normal
 * case rather than an anomaly.
 */
function formatAnytxtOutput(value) {
	const offset = typeof value.offset === "number" ? value.offset : 0;
	const counted = value.truncated
		? `Found ${value.items.length} of ${value.total} results (offset ${offset})`
		: `Found ${value.total} ${value.total === 1 ? "result" : "results"}`;
	const stats = `\nshown ${value.items.length} / total ${value.total} / nextOffset ${typeof value.nextOffset === "number" ? value.nextOffset : "-"}`;
	// 排除规则数照 Everything 的写法进结果头：默认排除不许是静默丢结果。0 条
	// （`exclude: ""`）不印，否则每页都挂一句「排除了 0 条」。
	const excluded = typeof value.excluded === "number" && value.excluded > 0 ? ` (${value.excluded} exclusion rule${value.excluded === 1 ? "" : "s"} applied)` : "";
	const header = `${counted}${excluded} — indexed copy, may be stale${stats}`;
	const body = value.items.map((item) => {
		const size = typeof item.size === "number" ? formatSize(item.size) || "-" : "-";
		// `modified` 是索引回给我们的 ISO(UTC)。这里必须换成**本地**时间：Everything 那一列
		// 就是本地时间，直接印 UTC 墙钟会让同一个文件在两个工具里差一个时区、且两边都没有
		// 时区标记，读的人只能得出「这是两个不同版本」。读不到照旧打 `-`。
		const modified = typeof item.modified === "string" ? (formatLocalStamp(new Date(item.modified)) ?? "-") : "-";
		// ref 必须在模型可见的这一行里：fid 无法从路径推导，渲染丢掉它等于 anytxt_read
		// 没有任何入口。它是独立的第一列，不并进 size/modified 列——那两列有「读不到
		// 就省键」的语义，混进去会让 ref 跟着一起丢。
		return `${item.ref}\t${item.path}\t${size}\t${modified}`;
	}).join("\n");
	if (!value.truncated) return `${header}\n\n${body}`;
	const footer = typeof value.nextOffset === "number"
		? `(Showing ${value.items.length} starting at offset ${offset}; pass offset ${value.nextOffset} or narrow the search to see more.)`
		: `(Showing the first ${value.items.length}; narrow the search to see more.)`;
	return `${header}\n\n${body}\n\n${footer}`;
}

/** The model-facing text of one `anytxt_read` answer, fragments or full text. */
function formatAnytxtRead(value) {
	if (value.mode === "fragments") return `${value.snippets.length} of ${value.totalSnippets} passage(s) for "${value.query}" in ${value.ref}\n\n${value.snippets.join("\n---\n")}`;
	const state = value.truncated ? ` (truncated at ${value.returned} of ${value.totalChars} characters)` : "";
	return `${value.returned} of ${value.totalChars} characters from offset ${value.offset}${state} — ${value.ref}\n\n${value.text}`;
}

/** The model-facing text of one `anytxt_status` answer: verdict, reason, endpoint. */
function formatAnytxtStatus(value) {
	const verdict = value.ok === true ? "ok" : "not usable";
	return `anytxt_status: ${verdict} (${value.code})\n${value.message}\n${value.url}`;
}

/** The model-facing text of one `anytxt_sync_index` answer. */
function formatAnytxtSync(value) {
	return `${value.folder}: ${value.ok === true ? "accepted" : "not accepted"} (${value.code})\n${value.message}`;
}

/** The two values `anytxt_read`'s `mode` takes. */
const ANYTXT_READ_MODES = new Set(["fragments", "full"]);

/**
 * Register the three Anytxt content tools - `anytxt_search`, `anytxt_read`,
 * `anytxt_status` - on every load, like the Everything tools.
 *
 * Nothing here touches the Everything path: no DLL binding, no worker thread,
 * no query-runtime state of its own (none of the `rt.workerEntry` / `rt.inFlight` /
 * `rt.chain` fields a `createQueryRuntime()` instance carries). These tools speak HTTP to
 * the Anytxt GUI on loopback, so a stopped Anytxt costs content search only.
 *
 * One tool per intent. The exclusivity rules of `anytxt_read` are checked in
 * `execute`, not in the schema: this host's value-schema DSL takes no
 * `oneOf` / `enum`, and an unsupported keyword drops the whole entry at
 * registration instead of failing loudly.
 */
function applyAnytxtTools(ctx, caps) {
	// 一条 prompt 段，只写分工与新鲜度两件事：语法要点和互斥规则都在各自 description
	// 与参数里，prompt 再抄一遍就是同一句话说两遍，只占字符。order 3254 是
	// everything_search 那段，这段排在它后面。
	ctx?.systemPrompt?.section?.({
		name: "tool:anytxt_search",
		order: PROMPT_ORDERS.anytxtSearch,
		text: `Use: anytxt_search for text inside PDF/DOCX/XLSX/PPTX/EPUB files - finding files by name stays everything_search's job, workspace source stays grep's.
The Anytxt index is its own copy: hits describe the indexed copy and may be stale, and dir only filters - it indexes nothing.
Read a hit back with anytxt_read: mode fragments for the passages around a query, mode full for the extracted text.`
	});
	ctx.tools.register(defineTool({
		name: "anytxt_search",
		description: `Find documents by content inside one indexed folder.
Usage: anytxt_search searches the text inside PDF/DOCX/XLSX/PPTX/EPUB files through the Anytxt index; everything_search stays the way to find files by name, grep the way to search source in the workspace.
Principle: one query, one intent; start from a narrow dir and a short phrase, widen to & | ! only when needed.
Constraints: dir is required and only filters the query - it indexes nothing, so a folder Anytxt has not indexed answers empty instead of an error; results describe the index's copy of each file, not the file on disk, so every hit is an indexed copy, may be stale; every hit line starts with the ref, and that first column is the only way to get one.
Semantics: a quoted pattern runs as an exact phrase - the quotes stay in the pattern, which is the only thing that decides it (this build ignores st, measured); limit defaults to ${caps.anytxtMaxResults}, capped at ${ANYTXT_MAX_LIMIT}; offset continues from nextOffset; size and modified are dropped when the index does not report them.
Report: quote the header as-is, keep the ref column when citing a hit, page with nextOffset, and say the answer describes the index copy when freshness matters.`,
		parameters: {
			pattern: {
				type: "string",
				required: true,
				description: "Content query: terms, & | ! and a quoted \"exact phrase\". Required."
			},
			dir: {
				type: "string",
				required: true,
				description: "One indexed directory to search inside. Required: a missing or blank dir is an argument error, never a whole-disk guess."
			},
			ext: {
				type: "string",
				description: "Extension filter handed to Anytxt as given, e.g. pdf. Optional."
			},
			limit: {
				type: "number",
				description: `Hits in this page. 1-${ANYTXT_MAX_LIMIT}, clamped when out of range; default ${caps.anytxtMaxResults}. Optional.`
			},
			offset: {
				type: "number",
				description: "Result offset, continues from nextOffset. Starts at 0, negatives clamp to 0. Optional."
			},
			order: {
				type: "number",
				description: `Sort order: ${[...ANYTXT_ORDER_VALUES.keys()].join("/")} = 0 default, 1 dateModified ascending, 2 dateModified descending, 3 path ascending, 4 path descending. Any other value is an argument error (the whitelist is checked in execute, not in the schema). Optional.`
			},
			exclude: {
				type: "string",
				description: `Defaults to ${DEFAULT_EXCLUDE_FRAGMENTS.join("; ")}; ";" separated path fragments, case-insensitive; \"\" disables them. The header reports how many rules applied. Optional.`
			}
		},
		timeoutMs: caps.anytxtTimeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								ref: { type: "string", required: true },
								path: { type: "string", required: true },
								size: { type: "number" },
								modified: { type: "string" }
							}
						}
					},
					total: { type: "number", required: true },
					truncated: { type: "boolean", required: true },
					offset: { type: "number" },
					nextOffset: { type: "number" },
					excluded: { type: "number" }
				}
			},
			render: (_args, value) => [{ type: "text", text: formatAnytxtOutput(value) }]
		},
		async execute(args, exec) {
			const input = args ?? {};
			const requested = Number(input.limit);
			const limit = Number.isFinite(requested) ? Math.min(ANYTXT_MAX_LIMIT, Math.max(1, Math.floor(requested))) : Math.min(ANYTXT_MAX_LIMIT, caps.anytxtMaxResults);
			// 白名单只在 execute 拦（本宿主的值 schema DSL 不收 enum），与 everything_search
			// 校验 sort / type 同一做法：非法值当场报错，不交给服务端去猜。
			const order = parseAnytxtOrder(input.order);
			return await searchContent({
				pattern: input.pattern,
				dir: input.dir,
				ext: input.ext,
				limit,
				order,
				exclude: input.exclude,
				offset: input.offset,
				url: caps.anytxtUrl,
				timeoutMs: caps.anytxtTimeoutMs,
				signal: exec?.signal
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "anytxt_read",
		description: `Read one indexed document by the ref anytxt_search returned.
Usage: mode fragments returns the passages around a query; mode full returns the extracted text from offset, at most max characters.
Principle: read fragments first to judge whether the document matters; ask for full text only when the passages are not enough.
Constraints: ref must be an anytxt: ref from anytxt_search; mode is fragments or full, default full; fragments needs query and takes no offset; max is shared - a passage count for fragments, a character window for full; full rejects query; offset there is a character position, not a page number.
Semantics: fragments default to 8 passages, capped at 8 - the server answers exactly 8 whatever limit is asked (measured), so nothing above 8 exists; full text defaults to 8000 characters, capped at 40000; totalChars is the whole extracted text, returned what this call carried.
Report: quote what came back, and continue with offset when the slice is truncated.`,
		parameters: {
			ref: {
				type: "string",
				required: true,
				description: "An anytxt: ref from anytxt_search - the first column of each hit line. Required; a ref of another engine is an argument error."
			},
			mode: {
				type: "string",
				description: "fragments (passages around query) or full (extracted text); defaults to full. Any other value is an argument error."
			},
			query: {
				type: "string",
				description: "Only for mode fragments, and then required: the terms whose passages you want."
			},
			offset: {
				type: "number",
				description: "Only for mode full: character position to start at, defaults to 0. Rejected together with fragments."
			},
			max: {
				type: "number",
				description: "Shared by both modes: for fragments the passages to return (default 8, capped at 8, the server's own ceiling), for full the characters to return (default 8000, capped at 40000)."
			}
		},
		timeoutMs: caps.anytxtTimeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ref: { type: "string", required: true },
					mode: { type: "string", required: true },
					query: { type: "string" },
					totalSnippets: { type: "number" },
					snippets: {
						type: "array",
						items: { type: "string" }
					},
					text: { type: "string" },
					totalChars: { type: "number" },
					returned: { type: "number" },
					offset: { type: "number" },
					truncated: { type: "boolean" }
				}
			},
			render: (_args, value) => [{ type: "text", text: formatAnytxtRead(value) }]
		},
		async execute(args, exec) {
			const input = args ?? {};
			const mode = input.mode === void 0 ? "full" : String(input.mode);
			if (!ANYTXT_READ_MODES.has(mode)) throw invalidArgument(`mode must be one of fragments, full (got ${String(input.mode)}): fragments returns the passages around a query, full returns the extracted text`, "mode has exactly two values, and neither is a synonym.");
			if (mode === "fragments") {
				if (input.query === void 0 || String(input.query).trim().length === 0) throw invalidArgument("mode fragments needs query: the terms whose passages you want; pass mode full to read the text instead", "fragments without a query has no passage to return.");
				// max is shared: fragments read it as a passage count (1-32, default 8),
				// full as a character window (1-40000). Only offset stays full-exclusive -
				// a passage list has no character position to start at.
				if (input.offset !== void 0) throw invalidArgument("offset belongs to mode full: a fragment answer is a passage list, not a character window, so drop offset or switch to full", "offset is a character position in the extracted text, not a passage rank.");
				const snippets = await getFragments({
					ref: input.ref,
					query: input.query,
					max: input.max,
					url: caps.anytxtUrl,
					timeoutMs: caps.anytxtTimeoutMs,
					signal: exec?.signal
				});
				return {
					ref: String(input.ref),
					mode,
					query: String(input.query),
					totalSnippets: snippets.totalSnippets,
					snippets: snippets.snippets
				};
			}
			if (input.query !== void 0) throw invalidArgument("mode full takes no query: query only selects passages in mode fragments", "the full text is the whole extraction, so there is nothing for a query to narrow.");
			const value = await getRawText({
				ref: input.ref,
				offset: input.offset,
				maxChars: input.max,
				url: caps.anytxtUrl,
				timeoutMs: caps.anytxtTimeoutMs,
				signal: exec?.signal
			});
			return {
				ref: String(input.ref),
				mode,
				text: value.text,
				totalChars: value.totalChars,
				returned: value.returned,
				offset: value.offset,
				truncated: value.truncated
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "anytxt_sync_index",
		description: `Build (or refresh) the Anytxt index for one folder.
Usage: anytxt_sync_index indexes the documents under one absolute Windows directory so anytxt_search can find their text; everything_search never needs it, and grep never reads this index.
Principle: name the folder the user means, by its own absolute path - a relative path, a forward-slash-only path and a missing folder are all argument errors, because the API answers success for all three and builds nothing (measured).
Constraints: this is the only call that changes index state; it never deletes, moves or renames anything. The folder must already exist.
Semantics: the path is normalized to backslashes before it is sent; building runs in the background, so the reply means the request was accepted, not that the index is ready - confirm with anytxt_search after a few seconds.
Report: say which folder was accepted, that the index is still being built, and how to confirm it.`,
		parameters: {
			folder: {
				type: "string",
				required: true,
				description: "Absolute Windows directory to index. Required; a relative, forward-slash-only or missing path is an argument error, never a silent no-op."
			}
		},
		timeoutMs: caps.anytxtSyncTimeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					folder: { type: "string", required: true },
					ok: { type: "boolean", required: true },
					code: { type: "string", required: true },
					message: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: formatAnytxtSync(value) }]
		},
		async execute(args, exec) {
			const input = args ?? {};
			return await syncIndex({
				folder: input.folder,
				url: caps.anytxtUrl,
				timeoutMs: caps.anytxtSyncTimeoutMs,
				signal: exec?.signal
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "anytxt_status",
		description: `Report whether anytxt_search can answer right now. Answers one question - is the content index usable - and nothing else: no query runs and no document is read. A code saying it is down is about the content index only, so everything_search and grep stay usable. Call it when a content search looks unusable.`,
		parameters: {},
		timeoutMs: caps.anytxtTimeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					code: { type: "string", required: true },
					message: { type: "string", required: true },
					url: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: formatAnytxtStatus(value) }]
		},
		async execute(_args, exec) {
			// 探测四态里只有 ok / code / message / url 出给模型：state 与 detail 会让模型
			// 去找环境（装 ATGUI、翻设置），正解是退回 grep 或说内容索引不可用。
			const verdict = await probeAnytxt({
				url: caps.anytxtUrl,
				timeoutMs: caps.anytxtTimeoutMs,
				signal: exec?.signal
			});
			return {
				ok: verdict.ok === true,
				code: verdict.code,
				message: verdict.message,
				url: typeof verdict.url === "string" ? verdict.url : caps.anytxtUrl
			};
		}
	}));
}

export const name = "dsh-tool-everything/anytxt";

/** 这一行做什么：内容检索，走 Anytxt 本地 9920。 */
export const description = "内容检索，走 Anytxt 本地 9920";

/** 本组件依赖的宿主服务：行被独立挂载时，loader 照这里注入。 */
export const inject = ["tools", "systemPrompt"];

export { Config };

/** 缺键一律取默认：子行裸挂时第二个参数是 `undefined`，旧写法读 `caps.anytxtMaxResults` 就抛。 */
export function resolveContentCaps(caps = {}) {
	const url = typeof caps?.anytxtUrl === "string" && caps.anytxtUrl.length > 0 ? caps.anytxtUrl : DEFAULT_ANYTXT_URL;
	// 预算在这里就把关：组件行是唯一生效的配置入口，而 `AbortSignal.timeout` 只收整数且
	// 0..4294967295，坏值过去会以一条没有 ANYTXT_* 错误码的裸 RangeError 逃出。非整数、
	// 小于 1 或超过 MAX_TIMER_DELAY_MS 一律回退默认（缺键容错，坏值回退）。
	const timeoutMs = resolveBudgetMs(caps?.anytxtTimeoutMs, ANYTXT_RPC_TIMEOUT_MS);
	const requestedLimit = Number(caps?.anytxtMaxResults);
	const maxResults = Number.isFinite(requestedLimit) ? Math.min(ANYTXT_MAX_LIMIT, Math.max(1, Math.floor(requestedLimit))) : ANYTXT_DEFAULT_LIMIT;
	const syncTimeoutMs = resolveBudgetMs(caps?.anytxtSyncTimeoutMs, DEFAULT_ANYTXT_SYNC_TIMEOUT_MS);
	return {
		anytxtUrl: url,
		anytxtTimeoutMs: timeoutMs,
		anytxtMaxResults: maxResults,
		anytxtSyncTimeoutMs: syncTimeoutMs
	};
}

/**
 * 内容面自己注册四条 `anytxt_*` 工具。外壳不再代注册、也不再喂 caps：裸挂一样能起来。
 */
export function apply(ctx, caps) {
	applyAnytxtTools(ctx, resolveContentCaps(caps));
}

export { applyAnytxtTools, formatAnytxtOutput };

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
	ANYTXT_MAX_CHARS,
	ANYTXT_MAX_FRAGMENTS,
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
	// 非首页也要带 offset：只按 truncated 判会把 `total=11, offset=10` 那一页印成
	// `Found 11 results`，读起来像「这就是全部」，往后翻的位置就丢了。
	const counted = value.truncated || offset > 0
		? `Found ${value.items.length} of ${value.total} results (offset ${offset})`
		: `Found ${value.total} ${value.total === 1 ? "result" : "results"}`;
	const stats = `\nshown ${value.items.length} / total ${value.total} / nextOffset ${typeof value.nextOffset === "number" ? value.nextOffset : "-"}`;
	// 排除规则数照 Everything 的写法进结果头：默认排除不许是静默丢结果。0 条
	// （`exclude: ""`）不印，否则每页都挂一句「排除了 0 条」。
	const excluded = typeof value.excluded === "number" && value.excluded > 0 ? ` (${value.excluded} exclusion rule${value.excluded === 1 ? "" : "s"} applied)` : "";
	// A-d：`total` 是「排除前」口径——同一行里 items 是排除后、total 是排除前、游标按原始
	// 行号前进，三个数各自正确，凑一行读起来却自相矛盾（评测为此连判错两轮），所以口径写明。
	const totalScope = typeof value.excluded === "number" && value.excluded > 0 && value.total > 0 ? `; total ${value.total} is the count before exclusion` : "";
	// A-b：空页不是「没有结果」——offset 越过总数时这一页天然为空，与 FIX-2 同款告警。
	const pastEnd = value.items.length === 0 && value.total > 0 && offset >= value.total ? ` — offset ${offset} is past the end: total is ${value.total}, so this page is empty; page from offset 0..${Math.max(0, value.total - 1)} or drop offset` : "";
	// A-a：limit 越界必须留痕。`limit: 0` 最危险——读起来像「不要结果」，实际给了 1 条。
	const limitNote = typeof value.limitClampedFrom === "number" ? `\nlimit ${value.limitClampedFrom} is outside 1-300 and was clamped; this page is not the size that was asked for` : "";
	const header = `${counted}${excluded}${pastEnd} — indexed copy, may be stale${totalScope}${stats}${limitNote}`;
	// 边界与分页说明放在结果里而不是工具定义里：真拿到这一页时才需要它们，平时不占
	// 常驻 description 的预算（everything_search 的头部也是这个做法）。
	const boundaries = "indexed copy, enabled types only: an unknown, bitmap or database file carries no text";
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
	// 零命中不是「不存在」：只有建过索引的目录、且启用类型才有文本，所以这一行必须说
	// 清两条边界，否则 0 条既可能是没有、也可能是没索引。
	if (value.total === 0 && value.items.length === 0) {
		// A-e：零命中时给的出路必须包含当次真正能去掉的过滤器。旧文案只说「换个短词或宽目录」，
		// 而 `ext: xyz` 把结果清零时唯一有效的动作是去掉 ext——everything_search 那边有 `drop ext:`。
		const dropClauses = `drop ext${typeof value.excluded === "number" && value.excluded > 0 ? ", drop exclude (pass exclude:\"\")" : ""}`;
		return `${header}\n\n(no match in the index - only folders an index was built for are searchable, and only the types Anytxt's index settings enable are extracted; widen: ${dropClauses}, use a shorter phrase, or a broader dir)`;
	}
	if (!value.truncated) return `${header}\n\n${body}\n\n(${boundaries})`;
	const footer = typeof value.nextOffset === "number"
		? `(Showing ${value.items.length} starting at offset ${offset}; pass offset ${value.nextOffset} or narrow the search to see more. ${boundaries}.)`
		: `(Showing the first ${value.items.length}; narrow the search to see more. ${boundaries}.)`;
	return `${header}\n\n${body}\n\n${footer}`;
}

/** The model-facing text of one `anytxt_read` answer, fragments or full text. */
function formatAnytxtRead(value) {
	if (value.mode === "fragments") {
		// A-c 的 fragments 侧：`max` 是段数（1–8，服务端恒回 8 段）。只在 full 分支印钳位提示的话，
		// `max: 0` / `max: 9` 被钳成 1 / 8 仍然一声不响——与 full 侧 `40001 -> 40000` 的待遇相反。
		const fragmentClampNote = typeof value.maxClampedFrom === "number" ? `\n(max ${value.maxClampedFrom} is outside the range this mode accepts and was clamped; this answer is not the size that was asked for)` : "";
		// 片段上限和中文倒序都放这里：只有真读了片段才需要知道这两条。
		return `${value.snippets.length} of ${value.totalSnippets} passage(s) for "${value.query}" in ${value.ref}\n\n${value.snippets.join("\n---\n")}\n\n(at most 8 passages exist; Anytxt passages can read backwards in Chinese - switch to mode full when one does)${fragmentClampNote}`;
	}
	const state = value.truncated ? ` (truncated at ${value.returned} of ${value.totalChars} characters)` : "";
	// 续读位置直接给出，不必让调用方自己算 offset + returned。
	const next = value.truncated ? `\n\n(continue with offset ${value.offset + value.returned})` : "";
	// A-c：`max` 越界不许静默——fragments 的上限是 8、full 的是 40000，两个数都在
	// `anytxt.mjs` 里定义；钳了就要说，否则调用方以为「要 40001 拿到 40000」是它自己的错。
	const clampNote = typeof value.maxClampedFrom === "number" ? `\n(max ${value.maxClampedFrom} is outside the range this mode accepts and was clamped; this slice is not the size that was asked for)` : "";
	return `${value.returned} of ${value.totalChars} characters from offset ${value.offset}${state} — ${value.ref}\n\n${value.text}${next}${clampNote}`;
}

/** The model-facing text of one `anytxt_status` answer: verdict, reason, endpoint. */
function formatAnytxtStatus(value) {
	const verdict = value.ok === true ? "ok" : "not usable";
	// 「只是内容索引坏了」这句跟着结果走：ok:false 时最容易被读成整台机器不可用。
	return `anytxt_status: ${verdict} (${value.code})\n${value.message}\n${value.url}\n(content index only: when this is down, everything_search and grep stay usable)`;
}

/** The model-facing text of one `anytxt_sync_index` answer. */
function formatAnytxtSync(value) {
	// 「accepted 不等于 ready」和「只有启用类型才有文本」都写在这里：建库时才需要，
	// 不必常驻在工具定义里。
	return `${value.folder}: ${value.ok === true ? "accepted" : "not accepted"} (${value.code})\n${value.message}\n(accepted, not ready - building runs in the background, so confirm with anytxt_search after a few seconds; only the types Anytxt's index settings enable get text, so an unknown, bitmap or database file is accepted with zero text and never matches)`;
}

/** The two values `anytxt_read`'s `mode` takes. */
const ANYTXT_READ_MODES = new Set(["fragments", "full"]);

/**
 * The only keys `anytxt_search` accepts. A key outside this set is an argument
 * error, not a silent ignore: this host's value-schema DSL drops no extra key on
 * its own, so `countOnly` used to arrive, be skipped, and still list paths - a
 * typo read exactly like an applied filter. There is deliberately no `countOnly`
 * here: `total` already reports the whole set, and items are bounded by `limit`.
 */
const ANYTXT_SEARCH_ARGS = new Set(["pattern", "dir", "ext", "limit", "offset", "order", "exclude"]);

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
	// 一条 prompt 段，只写分工、两条边界与新鲜度：语法要点和互斥规则都在各自
	// description 与参数里，prompt 再抄一遍就是同一句话说两遍，只占字符。order 3254 是
	// everything_search 那段，这段排在它后面。
	ctx?.systemPrompt?.section?.({
		name: "tool:anytxt_search",
		order: PROMPT_ORDERS.anytxtSearch,
		text: `Use: anytxt_search for text inside indexed folders' enabled types (PDF/DOCX/XLSX/PPTX/EPUB, Office, source); everything_search finds names, grep reads one known file.
Hits describe the indexed copy and may be stale; dir only filters; bitmaps, databases and unknown types carry no text.
Read back with anytxt_read (fragments or full); Chinese fragments can run backwards - use full.`
	});
	ctx.tools.register(defineTool({
		name: "anytxt_search",
		description: `Search indexed document text by content, inside one indexed folder or one indexed volume.
Usage: Anytxt's extracted text only, and only for the types its index settings enable; everything_search finds names, grep reads one known file.
Constraints: dir only filters - it indexes nothing; unknown, bitmap and database types carry no text; a key outside pattern/dir/ext/limit/offset/order/exclude is an argument error, and there is no countOnly.
Semantics: quotes make an exact phrase; limit defaults to ${caps.anytxtMaxResults}, capped at ${ANYTXT_MAX_LIMIT}; offset continues from nextOffset. The header and footers carry the freshness note, the paging handle and the zero-hit boundaries.`,
		parameters: {
			pattern: {
				type: "string",
				required: true,
				description: "Content query: terms, & | ! and a quoted \"exact phrase\". Required."
			},
			dir: {
				type: "string",
				required: true,
				description: "One indexed directory to search inside, or a drive root - filterDir is a prefix match, so C:\\ scopes to everything already in the index under C:, not to every file on the drive; an unindexed folder returns empty rather than an error. Required: a missing or blank dir is an argument error, never a whole-disk guess."
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
					excluded: { type: "number" },
					limitClampedFrom: { type: "number" }
				}
			},
			render: (_args, value) => [{ type: "text", text: formatAnytxtOutput(value) }]
		},
		async execute(args, exec) {
			const input = args ?? {};
			// 未知参数一律拒绝，不静默忽略：`countOnly` 传进来以前会被跳过，结果照样列出
			// 路径，读起来却像「只报了数」。合法键集只有 ANYTXT_SEARCH_ARGS 这一处定义。
			const unknown = Object.keys(input).filter((key) => !ANYTXT_SEARCH_ARGS.has(key));
			if (unknown.length > 0) throw invalidArgument(`anytxt_search takes only ${[...ANYTXT_SEARCH_ARGS].join(", ")}; got unknown ${unknown.map((key) => JSON.stringify(key)).join(", ")} - there is no countOnly: total already carries the whole set, and a page size is what bounds items`, "an unknown parameter is rejected so a typo cannot read as an applied filter.");
			const requested = Number(input.limit);
			const limit = Number.isFinite(requested) ? Math.min(ANYTXT_MAX_LIMIT, Math.max(1, Math.floor(requested))) : Math.min(ANYTXT_MAX_LIMIT, caps.anytxtMaxResults);
			// A-a：越界不静默。everything_search 的 maxResults 五个越界值都会在结果头写明被钳，
			// 这里以前四种取值三种表现（0 和 -2 回 1 条、301 和 1000 回全量）且一句提示都没有。
			const limitClampedFrom = input.limit !== void 0 && Number.isFinite(requested) && Math.floor(requested) !== limit ? requested : void 0;
			// 白名单只在 execute 拦（本宿主的值 schema DSL 不收 enum），与 everything_search
			// 校验 sort / type 同一做法：非法值当场报错，不交给服务端去猜。
			const order = parseAnytxtOrder(input.order);
			const value = await searchContent({
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
			// 有值才赋值：值为 undefined 的键会被 JSON.stringify 丢掉，宿主判无损 JSON 就不相等。
			if (limitClampedFrom !== void 0) value.limitClampedFrom = limitClampedFrom;
			return value;
		}
	}));
	ctx.tools.register(defineTool({
		name: "anytxt_read",
		description: `Read one indexed document by the anytxt: ref anytxt_search returned.
Usage: mode fragments returns the passages around query; mode full returns the extracted text from offset, at most max characters.
Constraints: fragments needs query and takes no offset; full takes no query; max is a passage count (at most 8) or a character window (at most 40000); offset is a character position, not a page number.
Semantics: the render reports totalChars, what this call carried, and the continuation handle when the slice is truncated.`,
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
					truncated: { type: "boolean" },
					maxClampedFrom: { type: "number" }
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
				// max is shared: fragments read it as a passage count (1-8, default 8 - the
				// server answers exactly 8 whatever limit is asked), full as a character
				// window (1-40000). Only offset stays full-exclusive - a passage list has
				// no character position to start at.
				if (input.offset !== void 0) throw invalidArgument("offset belongs to mode full: a fragment answer is a passage list, not a character window, so drop offset or switch to full", "offset is a character position in the extracted text, not a passage rank.");
				// A-c：fragments 的 max 区间是 1–8（服务端恒回 8 段），越界钳位必须留痕。
				const fragmentsClampedFrom = input.max !== void 0 && Number.isFinite(Number(input.max)) && Math.floor(Number(input.max)) !== Math.min(ANYTXT_MAX_FRAGMENTS, Math.max(1, Math.floor(Number(input.max)))) ? Number(input.max) : void 0;
				const snippets = await getFragments({
					ref: input.ref,
					query: input.query,
					max: input.max,
					url: caps.anytxtUrl,
					timeoutMs: caps.anytxtTimeoutMs,
					signal: exec?.signal
				});
				const fragmentValue = {
					ref: String(input.ref),
					mode,
					query: String(input.query),
					totalSnippets: snippets.totalSnippets,
					snippets: snippets.snippets
				};
				if (fragmentsClampedFrom !== void 0) fragmentValue.maxClampedFrom = fragmentsClampedFrom;
				return fragmentValue;
			}
			if (input.query !== void 0) throw invalidArgument("mode full takes no query: query only selects passages in mode fragments", "the full text is the whole extraction, so there is nothing for a query to narrow.");
			// A-c：full 的 max 是字符窗（1–40000），越界钳位同样留痕（旧行为 40001 静默取 40000）。
			const charsClampedFrom = input.max !== void 0 && Number.isFinite(Number(input.max)) && Math.floor(Number(input.max)) !== Math.min(ANYTXT_MAX_CHARS, Math.max(1, Math.floor(Number(input.max)))) ? Number(input.max) : void 0;
			const value = await getRawText({
				ref: input.ref,
				offset: input.offset,
				maxChars: input.max,
				url: caps.anytxtUrl,
				timeoutMs: caps.anytxtTimeoutMs,
				signal: exec?.signal
			});
			const fullValue = {
				ref: String(input.ref),
				mode,
				text: value.text,
				totalChars: value.totalChars,
				returned: value.returned,
				offset: value.offset,
				truncated: value.truncated
			};
			if (charsClampedFrom !== void 0) fullValue.maxClampedFrom = charsClampedFrom;
			return fullValue;
		}
	}));
	ctx.tools.register(defineTool({
		name: "anytxt_sync_index",
		description: `Re-scan one folder that is ALREADY inside Anytxt's indexing rules.
Usage: force a refresh so anytxt_search sees recent changes in an indexed folder. It does NOT add a folder to the searchable range - a folder outside Anytxt's index rules stays unsearchable however often it is synced (measured: two accepted syncs, Dir:1/File:3 enumerated, still 0 hits from a whole-drive query), so add a new root in the Anytxt GUI instead. everything_search never needs it, and grep never reads this index.
Constraints: the only call that changes index state; it never deletes, moves or renames; the folder must already exist, and a path with no drive letter is an argument error because the API answers success and builds nothing (measured); forward slashes are normalized first.
Semantics: the reply means accepted, not ready - the render says what it does and does not index, and how to confirm.`,
		parameters: {
			folder: {
				type: "string",
				required: true,
				description: "Absolute Windows directory to index. Required; a path with no drive letter (relative or root-relative) or a missing folder is an argument error, never a silent no-op. Forward slashes are accepted and normalized to backslashes."
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
		description: `Report whether anytxt_search can answer right now: one fixed-word, txt-only probe Search, so no document is read and the caller's query never runs. Call it when a content search looks unusable.`,
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

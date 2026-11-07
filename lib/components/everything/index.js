/**
 * @module dsh-tool-everything/everything
 *
 * 文件面组件：`everything_search` / `everything_status` 的注册面，加查询 worker 的实例状态
 * （`createQueryRuntime()` 返回的 `rt.*` 字段）。
 *
 * 与内容面零交叉 import：本模块不碰 `lib/components/anytxt/anytxt.mjs`。`probeHost` 与 `Config` 留在包本体的
 * `lib/index.js`——宿主能力探测与配置归外壳，组件只收 caps。
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { EverythingError, SORT_VALUES, closestSortKey } from "./sdk.mjs";
import { probeEverything } from "./status.mjs";
import { workerUrl } from "../../paths.mjs";
import { formatOutput, presentCall, presentResult } from "../../shared/format.mjs";
import { typeName } from "../../shared/type-name.mjs";
import { PROMPT_ORDERS } from "../../shared/prompt-orders.mjs";
import { Config } from "../../shared/config.mjs";
import { OFFSET_CAP, clampOffset, resolveBudgetMs } from "../../shared/limits.mjs";

//#region search-core
/**
 * Default cap on results retained inline by one call (the `maxResults` config).
 * Everything can match hundreds of thousands of files; the model only ever
 * sees this many paths inline, and the complete count is reported as `total`.
 */
const DEFAULT_MAX_RESULTS = 100;
/**
 * Hard ceiling on `maxResults`, whatever the config or the model asks for.
 * Every retained result costs a full path-buffer read, and an unbounded value
 * would flood the model context with paths it cannot use.
 */
const MAX_RESULTS_CAP = 500;
/**
 * `OFFSET_CAP` and `clampOffset` come from `lib/shared/limits.mjs`: both component
 * rows clamp into the same uint32 window, and the measured 2^32 wrap that set the
 * number is recorded next to it. Re-exported below under the same two names.
 */
/**
 * The kind filter: `file` and `dir` render as Everything's own type terms
 * `file:` and `folder:` (measured 0.4.7: `node_modules folder:` -> 393 dirs and
 * `node_modules file:` -> 2 files against 33309 total, with the reply's folder
 * boolean matching both), so this costs no new SDK binding. Lowercase only:
 * Everything ignores case, and one rendering keeps the search string stable.
 */
const TYPE_FILTERS = new Map([
	["file", "file:"],
	["dir", "folder:"]
]);
/**
 * Default cooperative tool-call timeout budget in milliseconds (the `timeoutMs`
 * config), attached to the tool definition for
 * `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce. The query runs in a
 * worker thread, so this event loop stays free; the budget is still short
 * because a native call already inside the DLL cannot be cancelled.
 */
const SEARCH_TIMEOUT_MS = 8e3;
/**
 * Directories excluded from every search by default (the `exclude` parameter's
 * default), as `!path:` fragments. Recycle-bin and system-cache entries
 * otherwise dominate the first page of broad searches such as `*.md`. The
 * exclusions stay explicit — the result header reports how many applied —
 * because silently dropping matches would add a new false negative.
 */
const DEFAULT_EXCLUDE_PATHS = ["$RECYCLE.BIN", "System Volume Information", "WinSxS"];

/**
 * The Everything SDK constants, bindings and error mapping live in
 * `./sdk.mjs`, which `./query-worker.mjs` imports as well: one copy only. Two
 * copies drift, and a drifted request flag reads every path back as an empty
 * string (FULL_PATH already did once).
 */


/** One-shot check that the tool-call context really carries an AbortSignal. */
let signalProbed = false;
function assertSignal(exec) {
	if (signalProbed) return;
	signalProbed = true;
	if (typeof exec?.signal?.aborted !== "boolean") throw new EverythingError(`tool-everything: host capability missing — exec.signal.aborted (expected boolean, got ${typeName(exec?.signal)}) at runQueryUnlocked (exec.signal.aborted checks) — the aborted checks cannot work without it`, "HOST_MISSING_SIGNAL");
}

/**
 * The query thread. `Everything_QueryW` blocks whoever calls it until the SDK
 * answers, so it runs in `lib/query-worker.mjs`: a slow query costs a worker,
 * not this event loop. The thread is spawned on first use; a dead or replaced
 * worker is simply forgotten and the next query starts a fresh one.
 */
const WORKER_URL = workerUrl;
const ABORTED_BEFORE = "everything_search was aborted before completion (tool timeout or caller cancellation)";
const ABORTED_WHILE = "everything_search was aborted while the query ran (tool timeout or caller cancellation)";
const WORKER_REPLACED = "everything_search was cancelled because the plugin was reloaded and its query worker replaced; retry the call";

/**
 * One query runtime: the worker entry and the single in-flight slot, kept in an
 * object instead of module scope so two components (two `apply` calls) never
 * settle each other's requests. The global names below act on the most recent
 * `apply`; a query issued before the first `apply` lazily creates one.
 */
function createQueryRuntime() {
	const rt = {
		workerEntry: void 0,
		inFlight: void 0,
		chain: Promise.resolve(),
		runQuery: (exec, input, caps) => runQueryOn(rt, exec, input, caps),
		runQueryUnlocked: (exec, input, caps) => runQueryUnlockedOn(rt, exec, input, caps),
		retire: (code, message) => retireWorkerOn(rt, code, message),
		replace: () => replaceWorkerOn(rt)
	};
	return rt;
}

/** Every runtime an `apply` mounted, keyed by the ctx that mounted it. */
const runtimes = new Map();
let defaultRuntime;

/** The runtime registered for one ctx, created on first use. */
function runtimeFor(ctx) {
	const existing = runtimes.get(ctx);
	if (existing !== void 0) return existing;
	const created = createQueryRuntime();
	runtimes.set(ctx, created);
	return created;
}

/** The instance the global names act on; created lazily so a pre-`apply` query still works. */
function defaultQueryRuntime() {
	if (defaultRuntime === void 0) defaultRuntime = createQueryRuntime();
	return defaultRuntime;
}

function workerThread(rt) {
	if (rt.workerEntry !== void 0) return rt.workerEntry;
	const thread = new Worker(fileURLToPath(WORKER_URL));
	// An idle worker must not hold the process open; a request in flight refs it again.
	thread.unref();
	const entry = { thread };
	thread.on("message", (message) => {
		// A replaced worker's late reply is dropped, never settled into the next request.
		if (rt.workerEntry !== entry) return;
		if (message.ok === true) settleRequest(rt, { value: message });
		else settleRequest(rt, { error: new EverythingError(message.message ?? "everything_search query failed", message.code ?? "EVERYTHING_QUERY_FAILED") });
	});
	thread.on("error", (error) => {
		if (rt.workerEntry !== entry) return;
		rt.workerEntry = void 0;
		settleRequest(rt, { error: new EverythingError(`everything_search query worker failed: ${error.message}`, "EVERYTHING_WORKER_FAILED", { cause: error }) });
	});
	thread.on("exit", (code) => {
		if (rt.workerEntry !== entry) return;
		rt.workerEntry = void 0;
		settleRequest(rt, { error: new EverythingError(`everything_search query worker exited before answering (code ${code}); the next call starts a fresh one`, "EVERYTHING_WORKER_EXITED") });
	});
	rt.workerEntry = entry;
	return entry;
}

/** Settle the one in-flight request of this runtime, if any; a replaced worker answers nothing. */
function settleRequest(rt, outcome) {
	const request = rt.inFlight;
	rt.inFlight = void 0;
	if (rt.workerEntry !== void 0) rt.workerEntry.thread.unref();
	if (request === void 0) return;
	if (outcome.error !== void 0) request.reject(outcome.error);
	else request.resolve(outcome.value);
}

/**
 * Retire the current worker and settle whatever request it was serving, in one
 * place. `worker.terminate()` cannot interrupt an `Everything_QueryW` already
 * inside the DLL - measured: terminate() returned in 6-8 ms but the thread still
 * posted one more reply afterwards, so it exits only once the native call
 * returns. The next request therefore starts a fresh thread; a query already
 * inside the DLL cannot be called back.
 *
 * The in-flight promise has to be settled here, and with its own code: dropping
 * the reference alone (what `apply()` used to do) leaves the awaiting call
 * hanging forever with nobody to report it, and an aborted call must not arrive
 * as a replaced worker either. `Promise.race([pending, abortedReply])` reports
 * whichever rejection lands first, so every caller passes its code in.
 */
function retireWorkerOn(rt, code, message) {
	settleRequest(rt, { error: new EverythingError(message, code) });
	const entry = rt.workerEntry;
	rt.workerEntry = void 0;
	if (entry === void 0) return;
	entry.thread.terminate().catch(() => void 0);
}

/** The no-argument form: retire this runtime's thread when no request is in flight to settle. */
function replaceWorkerOn(rt) {
	retireWorkerOn(rt, "EVERYTHING_WORKER_REPLACED", WORKER_REPLACED);
}

function askWorker(rt, request) {
	const entry = workerThread(rt);
	return new Promise((resolve, reject) => {
		rt.inFlight = { resolve, reject };
		try {
			entry.thread.ref();
			entry.thread.postMessage(request);
		} catch (error) {
			rt.inFlight = void 0;
			reject(new EverythingError(`everything_search could not reach its query worker: ${error.message}`, "EVERYTHING_WORKER_FAILED", { cause: error }));
		}
	});
}

/**
 * The single mutex on one runtime (`rt.chain`). `rt.inFlight` is one slot per
 * instance, not a table: two concurrent requests on the same row would overwrite
 * each other's resolve/reject pair and the first would never settle. So this
 * chain lets one request reach that runtime's worker at a time, and a failed
 * query does not break it. The worker's one-message-at-a-time rule only covers
 * inside the thread - it does not queue callers, which is exactly what this
 * chain is for. A per-request id table (true concurrency) is 0.5.0, not this
 * batch.
 */

/** Every `regex:` clause in a search expression, as the token after the prefix. */
function regexPatterns(search) {
	const patterns = [];
	// 引号形态 regex:"a b" 取引号内整段；未闭合的引号回退到 \S+，不抛错。
	const clause = /regex:(?:"([^"]*)"|(\S+))/g;
	let match;
	while ((match = clause.exec(search)) !== null) patterns.push(match[1] ?? match[2]);
	return patterns;
}

/**
 * Whether a pattern is obviously malformed: an unclosed group, an unclosed
 * character class, or a trailing escape. Only these fail the call — Everything's
 * regex subset differs from JavaScript's, so a pattern JavaScript rejects but
 * Everything accepts must pass through untouched.
 */
function isClearlyMalformed(pattern) {
	let groups = 0;
	let classes = 0;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "\\") {
			index++;
			if (index >= pattern.length) return true;
			continue;
		}
		if (char === "(") groups++;
		else if (char === ")") groups--;
		else if (char === "[") classes++;
		else if (char === "]") classes--;
	}
	return groups !== 0 || classes !== 0;
}

/** Reject a `regex:` clause JavaScript cannot compile and that is plainly malformed; otherwise let Everything judge it. */
function validateRegexes(search) {
	for (const pattern of regexPatterns(search)) {
		try {
			new RegExp(pattern);
		} catch (error) {
			if (isClearlyMalformed(pattern)) throw new EverythingError(`everything_search received an invalid regular expression in its regex: clause: ${pattern}`, "INVALID_REGEX", { cause: error });
		}
	}
}

/** Resolve the `exclude` parameter: `undefined` keeps the defaults, an empty string disables them. */
function parseExclude(value) {
	if (value === void 0) return DEFAULT_EXCLUDE_PATHS.slice();
	return value.split(";").map((rule) => rule.trim()).filter((rule) => rule.length > 0);
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank search
 * whose `regex:` clauses are not obviously broken. Throws a plain `Error` (an
 * ordinary tool argument error) or an {@link EverythingError} otherwise.
 */
function parseArgs(args) {
	if (typeof args?.search !== "string") throw new Error("search must be a string");
	const search = args.search.trim();
	if (search.length === 0) throw new Error("search must be a non-empty string");
	validateRegexes(search);
	return {
		...args,
		search
	};
}

/** Quote a `path:` scope containing whitespace or a quote, so Everything does not split it into separate terms. */
function quotePathScope(scope) {
	return /[\s"]/.test(scope) ? `"${scope}"` : scope;
}

/**
 * Walk up from one `path` scope to its nearest existing ancestor, so a typo'd
 * scope names a directory the caller can actually check. Returns "" when no
 * ancestor exists (a missing drive): there is nothing to suggest then.
 */
function nearestExistingAncestor(scope) {
	let current = scope;
	for (;;) {
		const parent = dirname(current);
		if (parent === current) return "";
		if (existsSync(parent)) return parent;
		current = parent;
	}
}

/**
 * Compose the Everything search string: an optional `path:` scope is appended
 * so a relative `path` (e.g. "D:\\code") keeps working exactly as written.
 * Everything's own syntax handles the rest (wildcards, functions, operators).
 * A scope that does not exist is an argument error rather than a silent zero
 * result.
 */
function buildSearch(input, excludeRules = [], notes) {
	const terms = [input.search];
	const scope = input.path === void 0 ? "" : input.path.trim();
	// 搜索串里已带 path: 就不再追加：两个 path: 会互相 AND，结果恒为空。
	if (scope.length > 0 && !/\bpath:/i.test(input.search)) {
		// 通配 scope 是 Everything 的合法写法（path:D:/code/*），整串 stat 必假：旧代码
		// 先 existsSync 再看通配，于是带通配的 path 永远报「path does not exist」，后面
		//  tolerate `*?` 那半句是死代码。通配串没有可 stat 的对象，这里跳过存在性检查；
		// 固定路径照旧校验，拼错的目录仍当场报错，不把假阴性换成假阳性。
		const missing = !/[*?]/.test(scope) && !existsSync(scope);
		// 诊断写全 + 显式开关。默认仍抛错，但消息要能自己把自己修好：原始 scope、逐级
		// 上溯到的最近存在父目录、三条出路。只有调用方显式传 pathMustExist:false 才降级
		// 为忽略 scope（由 notes 回报、结果头明写「path ignored」）——静默空结果会把
		// 「路径写错」和「目录里确实没有」混成同一个回答，那正是前几轮在修的反面。
		const ignoreMissing = missing && input.pathMustExist === false;
		if (missing && !ignoreMissing) {
			const ancestor = nearestExistingAncestor(scope);
			throw new Error(`path does not exist: ${scope}${ancestor.length > 0 ? ` (nearest existing parent: ${ancestor})` : ""}; check the folder exists, pass a wildcard scope (e.g. "D:/code/*"), or omit path: to search the whole index - or set pathMustExist: false to ignore the scope.`);
		}
		if (ignoreMissing) {
			if (notes !== void 0) notes.ignoredScope = scope;
		} else {
			// 只规范化 scope 自己的分隔符，input.search 原样保留。
			const normalized = scope.replace(/\//g, "\\");
			// 补尾分隔符，让 Everything 匹配目录内容而非目录名本身；已以分隔符结尾或已含通配的 scope 原样使用。
			const scoped = /[\\]$/.test(normalized) || /[*?]/.test(normalized) ? normalized : `${normalized}\\`;
			terms.push(`path:${quotePathScope(scoped)}`);
		}
	}
	// type 渲染成 Everything 自己的类型词：file → file:、dir → folder:（实测
	// node_modules folder: 393 条目录、node_modules file: 2 条文件，对着全量 33307；
	// 回包的 folder 布尔与之同源，零新 SDK 绑定）。串里已带 file:/folder: 就不再
	// 追加——两个词会 AND 成 0（实测 *.dll file: folder: 是 0 条），静默归零比报错
	// 贵，所以把「没追加」做成值字段回报、由结果头写明，不许拼字符串混进 header。
	const typeTerm = input.type === void 0 ? "" : (TYPE_FILTERS.get(input.type) ?? "");
	if (typeTerm.length > 0) {
		if (/\b(?:file|folder):/i.test(input.search)) {
			if (notes !== void 0) notes.skippedType = input.type;
		} else {
			terms.push(typeTerm);
		}
	}
	for (const rule of excludeRules) terms.push(`!path:${quotePathScope(rule)}`);
	return terms.join(" ");
}


/**
 * Query Everything through the worker thread, one request at a time, collecting
 * `caps.maxResults` results from `caps.offset`. The native call itself runs in
 * `lib/query-worker.mjs`, so this event loop stays free while a query runs; a
 * failed query does not break the chain.
 */
async function runQueryOn(rt, exec, input, caps) {
	const run = rt.chain.then(() => runQueryUnlockedOn(rt, exec, input, caps), () => runQueryUnlockedOn(rt, exec, input, caps));
	rt.chain = run.then(() => void 0, () => void 0);
	return await run;
}

/**
 * The global names: same signatures as before this split, acting on the runtime
 * of the most recent `apply`. A call made before the first `apply` lazily creates
 * one instead of throwing, so single-row callers never have to know about rows.
 */
async function runQuery(exec, input, caps) {
	return await defaultQueryRuntime().runQuery(exec, input, caps);
}

async function runQueryUnlocked(exec, input, caps) {
	return await defaultQueryRuntime().runQueryUnlocked(exec, input, caps);
}

function replaceWorker() {
	defaultQueryRuntime().replace();
}

function retireWorker(code, message) {
	defaultQueryRuntime().retire(code, message);
}

async function runQueryUnlockedOn(rt, exec, input, caps) {
	if (exec.signal.aborted) throw new EverythingError(ABORTED_BEFORE, "SEARCH_ABORTED");
	const excludeRules = caps.exclude ?? [];
	// The offset ceiling is enforced here, at the one point both `execute` and a
	// direct `runQuery` pass through: Everything_SetOffset takes a uint32 and 2^32
	// silently wrapped back to page 0 while value.offset echoed the raw argument
	// (measured). Clamping in `execute` alone misses callers that go straight to
	// runQuery, and the footer would keep handing out an offset the SDK never saw.
	const offset = clampOffset(caps.offset);
	const countOnly = caps.countOnly === true;
	// buildSearch 顺带回报被 pathMustExist:false 丢掉的 scope，结果头要据此标注。
	const scopeNotes = {};
	const request = {
		search: buildSearch(input, excludeRules, scopeNotes),
		maxResults: caps.maxResults,
		offset,
		sort: caps.sort,
		descending: caps.descending === true,
		countOnly,
		autoStart: caps.autoStart === true,
		everythingDllPath: caps.everythingDllPath
	};
	// An abort drops the reply and hands the next query a fresh worker: terminate()
	// cannot stop a native call already inside the DLL (measured - it exits only
	// after that call returns), so the old thread finishes in the background and
	// answers nobody. This is not "cancellable in flight" and is not claimed as such.
	const pending = askWorker(rt, request);
	pending.catch(() => void 0);
	const canListen = typeof exec.signal.addEventListener === "function";
	let onAbort;
	const abortedReply = new Promise((_resolve, reject) => {
		onAbort = () => {
			// 同一出口，同一个码：retireWorker 把在途请求也 settle 成 SEARCH_ABORTED，
			// 于是 pending 与 abortedReply 谁先落定，调用方拿到的都是 SEARCH_ABORTED，
			// 不会被换成 WORKER_REPLACED。
			retireWorkerOn(rt, "SEARCH_ABORTED", ABORTED_WHILE);
			reject(new EverythingError(ABORTED_WHILE, "SEARCH_ABORTED"));
		};
		if (canListen) exec.signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const reply = await Promise.race([pending, abortedReply]);
		const items = reply.items ?? [];
		// countOnly 只报数，items 恒空：`0 + 0 < total` 会把 truncated 判成 true，
		// 页脚就冒出「pass offset 0」这种把人往沟里带的建议。这里固定 false，
		// nextOffset 自然不出现，文案交给 formatOutput 的 countOnly 分支。
		const truncated = countOnly ? false : offset + items.length < reply.total;
		const value = {
			items,
			total: reply.total,
			truncated,
			offset,
			countOnly,
			dbLoaded: reply.dbLoaded,
			excluded: excludeRules.length
		};
		// 有值才赋值：JSON.stringify 会把值为 undefined 的键整个丢掉，严格往返比对就不相等
		// （实测 value 里恒有两个 undefined 键）。照 nextOffset 那套条件赋值写，别留空键。
		if (scopeNotes.ignoredScope !== void 0) value.pathIgnored = scopeNotes.ignoredScope;
		if (scopeNotes.skippedType !== void 0) value.typeIgnored = scopeNotes.skippedType;
		if (truncated) value.nextOffset = offset + items.length;
		return value;
	} finally {
		if (canListen) exec.signal.removeEventListener("abort", onAbort);
	}
}
//#endregion


/**
 * The `everything_search` parameter spec, shared by the tool definition and the
 * load-time probe. Bounds live in `description` only: this host's value schema
 * DSL rejects `minimum`/`maximum` and the whole range/pattern family, and one
 * unsupported key throws a JsonSchemaError that drops the entire entry at
 * registration. The clamp itself stays in `execute`.
 */
function buildParameters(caps) {
	return {
		search: {
			type: "string",
			required: true,
			description: 'File-name expression, name-match; path: narrows scope; regex: "quoted form", spaces ok; required.'
		},
		path: {
			type: "string",
			description: "Directory scope → path:<value>; auto-quote if space or quote; pathMustExist: false ignores a missing scope."
		},
		pathMustExist: {
			type: "boolean",
			description: 'Default true: missing path → argument error with nearest existing parent; false → ignore scope, header says "path ignored: does not exist".'
		},
		maxResults: {
			type: "number",
			description: `1–${MAX_RESULTS_CAP}, clamped when out of range; default ${caps.maxResults}.`
		},
		offset: {
			type: "number",
			description: `Continues from nextOffset; starts at 0, negatives clamp to 0; mutually exclusive with countOnly.`
		},
		exclude: {
			type: "string",
			description: `Defaults to ${DEFAULT_EXCLUDE_PATHS.join("; ")}; ";" separated → !path:<fragment>; "" disables.`
		},
		sort: {
			type: "string",
			description: `name|path|size|dateModified|dateCreated; invalid → argument error (no enum in this host's value DSL, so the whitelist is checked in execute).`
		},
		descending: {
			type: "boolean",
			// 与 sdk.sortValueFor 同口径：sort 缺省时按 name 处理，无条件加降序偏移。
			// 旧文案写「sort 缺省时忽略」，与实现、与 prompt 段正好相反，是这条唯一的实质缺陷。
			description: "Reverse order; sort omitted → name descending (not ignored)."
		},
		countOnly: {
			type: "boolean",
			description: "Total match count only; items stays empty, nothing decoded; mutually exclusive with a positive offset (both at once is an argument error)."
		},
		type: {
			type: "string",
			description: "file|dir → file:/folder:; argument error if the search string already carries file: or folder: (two type terms AND to zero results)."
		}
	};
}

/**
 * Register the `everything_search` tool and its system-prompt guidance.
 */
function applyTool(ctx, caps) {
	ctx.systemPrompt.section({
		name: "tool:everything_search",
		order: PROMPT_ORDERS.everythingSearch,
		// 0.4.11：prompt 只留两件——「要不要调这个工具」（用途与分工）和「怎么汇报」（跨轮行为）。
		// 语法要点、regex: 引号形态、shown/total 读法、跨参数陷阱全部归工具 description 与各参数
		// description：那两份每轮都在上下文里，prompt 再抄一遍就是同一句话说两遍，只占字符。
		text: `Before work: one everything_search first — find what the machine already has for this task.
Mid-task: something missing? search first, then guess, ask, or stub.
Use: everything_search for whole-disk discovery by name — contents are grep's, in-workspace paths are glob's. Index up? ask everything_status; an empty result still means fall back to grep/glob.
Argument rules live in the tool and parameter descriptions.
Report in three steps: header, paths verified with read or glob, paging; unverified paths stay "candidate, unverified".`,
	});
	const tool = defineTool({
		name: "everything_search",
		description: `Usage: find files by NAME, whole disk — start exact, relax to wildcard.
Principle: one query, one intent. Order: exact name → path:/ext:/size: → wildcard. Header: "Found M results" (full) | "Found N of M results (offset X)" (paged) + line "shown N / total M / nextOffset X".
Constraints: index-not-loaded / dbLoaded:false → empty = inconclusive ⇒ ask everything_status; a search never probes.
Semantics: maxResults defaults to ${caps.maxResults}, capped at ${MAX_RESULTS_CAP}, clamped. countOnly = total only, items empty. sort omitted + descending:true = name descending (not ignored). mtime = epoch ms. regex: double-quoted form, spaces ok → regex:"final report".
Report: quote header as-is → verify paths by read/glob → say how to page. Sample-only = "candidate, unverified".
Scope: default exclusions ${DEFAULT_EXCLUDE_PATHS.join("; ")}; exclude:"" = include them back.`,
		parameters: buildParameters(caps),
		timeoutMs: caps.timeoutMs,
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
								path: { type: "string", required: true },
								folder: { type: "boolean", required: true },
								size: { type: "number", required: true },
								mtime: { type: "number", required: true }
							}
						}
					},
					total: { type: "number", required: true },
					truncated: { type: "boolean", required: true },
					nextOffset: { type: "number" },
					offset: { type: "number" },
					countOnly: { type: "boolean" },
					dbLoaded: { type: "boolean", required: true },
					excluded: { type: "number" },
					pathIgnored: { type: "string" },
					typeIgnored: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatOutput(value)
			}],
			presentationMeta: (_args, value) => ({
				paths: value.items.map((item) => item.path),
				truncated: value.truncated,
				total: value.total
			})
		},
		async execute(args, exec) {
			assertSignal(exec);
			const input = parseArgs(args);
			// Bounds live in `description` only: this host's value schema DSL rejects
			// minimum/maximum, so this clamp is the one place that enforces them. A
			// non-finite argument would reach the SDK as NaN - Everything then matches
			// nothing at all, which reads as "not in the index" instead of a bad call.
			const requestedMaxResults = Number(input.maxResults);
			const maxResults = Number.isFinite(requestedMaxResults) ? Math.min(MAX_RESULTS_CAP, Math.max(1, Math.floor(requestedMaxResults))) : caps.maxResults;
			// Same clamp as runQueryUnlocked, one implementation (clampOffset): SetOffset
			// takes a uint32, and 2^32 wrapped back to page 0 silently (measured).
			const offset = clampOffset(input.offset);
			const exclude = parseExclude(input.exclude);
			// 白名单只有 SORT_VALUES 一份；近邻算法放 sdk 侧紧邻它，两处不会漂。不认识的取值
			// 给一个近亲（`mtime` → `dateModified`），实在不像就只列白名单——瞎猜一个键比列
			// 白名单更贵：模型会照着猜错的那个再试一遍。参数组合/取值都只在 execute 报。
			if (input.sort !== void 0 && !SORT_VALUES.has(input.sort)) {
				const suggestion = closestSortKey(input.sort);
				throw new Error(`sort must be one of ${[...SORT_VALUES.keys()].join(", ")}${suggestion === void 0 ? "" : ` - did you mean "${suggestion}"?`} (keys are case-sensitive; any other value is rejected)`);
			}
			// type 的白名单校验与 sort 同层、同理由：本宿主的值 schema DSL 不收 enum，取值只能
			// 在 execute 拦。合法值就两个，不做近似建议，报错直接把两个列出来。
			if (input.type !== void 0 && !TYPE_FILTERS.has(input.type)) throw new Error(`type must be one of ${[...TYPE_FILTERS.keys()].join(", ")}`);
			// type 与串内 file:/folder: 撞车也只在这里报：两个类型词 AND 成 0（实测
			// *.dll file: folder: 是 0 条），旧行为静默跳过、只在结果头写一句，调用方
			// 把「参数自相矛盾」读成「索引里没有」。buildSearch 的跳过分支原样留着供
			// 直接调用，工具面走不到它。
			if (input.type !== void 0 && /\b(?:file|folder):/i.test(input.search)) throw new Error(`type cannot be combined with a search that already carries file: or folder: - two type terms AND to zero results, so the search would match nothing instead of finding files; drop type: ${input.type} to keep the search's own file:/folder: filter, or remove that term from search to let type: ${input.type} apply`);
			// 参数组合互斥只落在 execute：值域（offset 钳位）下沉到 runQueryUnlocked 是因为
			// 所有调用者都得过；而「countOnly 配正的 offset」只在工具入口这一层算参数错误。
			// 判断用钳后的值，于是 undefined / 0 / 负数 / 小数都不误伤。旧行为是同一个 total
			// 静默返回、truncated 恒 false，等于把参数吞掉——显式失败比静默无效便宜。
			if (input.countOnly === true && offset > 0) throw new Error("countOnly cannot be combined with a positive offset: total is the whole set, not a page, so drop offset to size a query, or drop countOnly to page; the SDK cannot report how many matches remain after an offset, so there is no 'rest after offset' count to hand back.");
			// path 与串内 path: 撞车也只在这里报，与 type 同一条规则、同一个理由：两个 path: 会互相
			// AND，结果恒为空；旧行为是静默跳过 path 参数，调用方把「参数被吞掉」读成「该目录里没有」。
			// buildSearch 里那段跳过分支原样留着（两个 path: 只可能来自直接调用），工具面走不到它。
			if (input.path !== void 0 && String(input.path).trim().length > 0 && /\bpath:/i.test(input.search)) throw new Error(`path cannot be combined with a search that already carries path: - the two would AND to zero results, so the search would match nothing instead of narrowing; drop the path parameter to keep the search's own path: scope, or remove path: from search to let path: ${String(input.path).trim()} apply`);
			return await runtimeFor(ctx).runQuery(exec, input, {
				...caps,
				maxResults,
				offset,
				exclude,
				sort: input.sort,
				descending: input.descending === true,
				countOnly: input.countOnly === true
			});
		},
		presentCall,
		presentResult
	});
	ctx.tools.register(tool);
}

/**
 * The model-facing text of one `everything_status` value: the verdict first,
 * then the one-line reason and what answered. Deliberately no repair steps.
 */
function formatStatus(value) {
	const verdict = value.ok === true ? "ok" : "not usable";
	const lines = [`everything_status: ${verdict} (${value.code})`, value.message];
	if (value.version !== void 0) lines.push(`SDK ${value.version}`);
	if (value.path !== void 0) lines.push(value.path);
	return lines.join("\n");
}

/**
 * Register the `everything_status` probe tool. It answers one question - can
 * `everything_search` be used right now - and nothing else: no query, no result
 * decoding, and no repair steps in the model-facing view (a model that reads
 * "a DLL is missing" goes off to install things, while the right move is to
 * fall back to grep/glob and say the local index is unavailable).
 */
function applyStatusTool(ctx, caps) {
	const tool = defineTool({
		name: "everything_status",
		description: `Report whether everything_search can answer right now. Reads the Everything index's loaded flag and the SDK version only - no query runs and no result is decoded. ok:true means searches can answer; ok:false carries a code and a one-line reason, and a skipped or cancelled probe never means the index is down. Call it when a search looks unusable or a result came back on an unloaded index.`,
		parameters: {},
		timeoutMs: caps.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					code: { type: "string", required: true },
					message: { type: "string", required: true },
					version: { type: "string" },
					path: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: formatStatus(value)
			}]
		},
		async execute(_args, exec) {
			return await probeEverything(caps, exec);
		}
	});
	ctx.tools.register(tool);
}


/**
 * Mount one query runtime for this ctx: retire the instance this ctx had before (its
 * in-flight request belongs to the instance being replaced), register the fresh one,
 * point the global names at it, and register the optional disposer. The disposer is
 * optional on purpose: a host without `ctx.effect` (the fake ctx the tests pass) must
 * still load, and this must never turn into a load-time capability probe.
 */
function mountRuntime(ctx) {
	const previous = runtimes.get(ctx);
	if (previous !== void 0) previous.retire("EVERYTHING_WORKER_REPLACED", WORKER_REPLACED);
	const runtime = createQueryRuntime();
	runtimes.set(ctx, runtime);
	defaultRuntime = runtime;
	if (typeof ctx?.effect === "function") {
		ctx.effect(() => () => {
			if (runtimes.get(ctx) !== runtime) return;
			runtimes.delete(ctx);
			runtime.retire("EVERYTHING_WORKER_REPLACED", WORKER_REPLACED);
			if (defaultRuntime === runtime) defaultRuntime = [...runtimes.values()][0];
		}, "tool-everything: query runtime");
	}
	return runtime;
}

export const name = "dsh-tool-everything/everything";

/** 这一行做什么：文件名检索，走 Everything64.dll。 */
export const description = "文件名检索，走 Everything64.dll";

/** 本组件依赖的宿主服务：行被独立挂载时，loader 照这里注入。 */
export const inject = ["tools", "systemPrompt"];

export { Config };

/**
 * 缺键一律取默认：子行被 loader 独立挂载时第二个参数是 `undefined`（行里没有
 * `config:` 块），旧写法一进门读 `caps.maxResults` 就抛 TypeError，UI 打「异常」。
 */
export function resolveFileCaps(caps = {}) {
	const requested = Number(caps?.maxResults);
	const maxResults = Number.isFinite(requested) ? Math.min(MAX_RESULTS_CAP, Math.max(1, Math.floor(requested))) : DEFAULT_MAX_RESULTS;
	// 与内容面同一条校验：坏预算回退默认，绝不让非整数或越界值走到 AbortSignal.timeout。
	const timeoutMs = resolveBudgetMs(caps?.timeoutMs, SEARCH_TIMEOUT_MS);
	return {
		maxResults,
		timeoutMs,
		everythingDllPath: caps?.everythingDllPath,
		autoStart: caps?.autoStart === true
	};
}

/**
 * 文件面组件自己注册：挂本 ctx 的查询实例，再注册 `everything_search` 与
 * `everything_status`。外壳不再代注册、也不再喂 caps——裸挂一样能起来。
 */
export function apply(ctx, caps) {
	const resolved = resolveFileCaps(caps);
	mountRuntime(ctx);
	applyTool(ctx, resolved);
	applyStatusTool(ctx, resolved);
}
export {
	applyStatusTool,
	applyTool,
	assertSignal,
	buildParameters,
	buildSearch,
	clampOffset,
	createQueryRuntime,
	DEFAULT_EXCLUDE_PATHS,
	DEFAULT_MAX_RESULTS,
	formatStatus,
	isClearlyMalformed,
	MAX_RESULTS_CAP,
	mountRuntime,
	OFFSET_CAP,
	parseArgs,
	parseExclude,
	quotePathScope,
	regexPatterns,
	replaceWorker,
	retireWorker,
	runQuery,
	runQueryUnlocked,
	runtimeFor,
	SEARCH_TIMEOUT_MS,
	validateRegexes,
};

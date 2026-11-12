/**
 * @module dsh-tool-everything/everything
 *
 * 文件面组件：`everything_search` / `everything_status` 的注册面，加查询 worker 的实例状态
 * （`createQueryRuntime()` 返回的 `rt.*` 字段）。
 *
 * 与内容面零交叉 import：本模块不碰 `lib/components/anytxt/anytxt.mjs`。`probeHost` 与 `Config` 留在包本体的
 * `lib/index.js`——宿主能力探测与配置归外壳，组件只收 caps。
 */
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEFAULT_SORT, EverythingError, SORT_VALUES, closestSortKey } from "./sdk.mjs";
import { probeEverything } from "./status.mjs";
import { workerUrl } from "../../paths.mjs";
import { formatOutput, presentCall, presentResult } from "../../shared/format.mjs";
import { typeName } from "../../shared/type-name.mjs";
import { PROMPT_ORDERS } from "../../shared/prompt-orders.mjs";
import { Config } from "../../shared/config.mjs";
import { OFFSET_CAP, clampOffset, resolveBudgetMs } from "../../shared/limits.mjs";
import { MAX_SLOTS, createSlotLimiter } from "../../shared/slots.mjs";

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
 * 默认并发查询数：1 = 与「单在途链」时代逐字等价（装上即无行为变化）。
 * 与 `lib/shared/config.mjs` 的 `concurrency` 默认值互校，见 test/verify.mjs。
 */
const DEFAULT_CONCURRENCY = 1;
/**
 * 并发上限。每个并发查询是一个 node 子进程 + 一个 Everything64.dll 实例；这也是
 * 子进程池的容量。`lib/shared/slots.mjs` 的 `MAX_SLOTS` 是同一个数的唯一定义处，
 * 这里只做别名，以便与其它上限一起导出。
 */
const MAX_CONCURRENCY = MAX_SLOTS;
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
 * `folder:` / `file:` inside the search string, if any. Everything's own function
 * syntax is the only place these macros appear, so one scan is enough; the first
 * macro wins because that is the one the caller reads first. `kind` is the type it
 * asserts (`dir` for `folder:`), `without` is the search string with that one term
 * removed - the exact shape of the rewrite handed back when the macro collides
 * with the `type` parameter.
 */
const TYPE_MACRO = /\b(file|folder):("[^"]*"|[^\s]*)/i;
/**
 * Everything 里能收窄候选集的「便宜」术语（只读索引，不碰磁盘）。
 *
 * 提在模块级而不是 execute 内部，是因为**超时文案也要用它**：watchdog 在
 * runQueryUnlockedOn 里生成「下一步怎么办」时，必须先判断这次查询到底有没有 scope，
 * 才能给出对应那一条可复制的改写。原先它定义在 execute 作用域里，超时回调看不见；
 * 一份正则两处用，放在模块级是唯一不产生第二份副本的位置。
 */
const NARROWING_TERM = /(^|[\s<>])!?(?:path|loc|location|ext|size|dm|date-modified|dc|date-created|da|date-accessed|parent|depth|parent-count):/i;
// `type:` 不是 Everything 的函数，它是本工具自己的独立参数。写进 search 的调用方（实测：
// `node_modules type:dir` 回 0 条）以为在做类型过滤，实际是把 `type:dir` 当成字面文件名去
// 匹配，于是「参数用错」被读成「磁盘上没有」——与 file:/folder: 撞车同一条规则，显式失败。
// TYPE_MACRO 只认 file|folder，所以内联的 type: 此前完全无人拦截，这条正则专治它。
const TYPE_INLINE = /\btype:("[^"]*"|[^\s]*)/i;
// Everything 的原生排序函数。与 type: 不同，它确实会被 Everything 接受——但它是排序指令、
// 不参与过滤，而 SetSort 是进程级全局状态，于是串内这一项会静默盖掉 sort/descending 参数。
const INLINE_SORT = /\bsort:("[^"]*"|[^\s]*)/i;
// 本工具自己的参数名，写进 search 就会被当成字面查询词去 AND（实测全部归零）。它们不是
// Everything 函数，也没有任何「看起来应该生效」的理由——但一旦误写，静默归零与「磁盘上没有」
// 无法区分，所以与 type: 同一条规则：显式失败。sort 另走 INLINE_SORT（它的症状是错序，不是归零）。
const SEARCH_PARAM_NAMES = ["pathMustExist", "maxResults", "offset", "exclude", "descending", "countOnly"];
const EXT_TERM = /(^|[\s<>])ext:([^\s]*)/i;
function readTypeMacro(search) {
	const text = String(search);
	// 引号里的是字面量：`"folder:docs"` 是在文件名里找那 11 个字，不是类型断言。
	// 压测实测（2026-11-09）：不剥引号时 `ext:txt "folder:docs"` 被 E_TYPE_CONFLICT
	// 判死，而 Everything 那边它只是一次正常的字面匹配——守卫自己制造了假阴性。
	const live = findUnquotedMacro(text);
	if (live === void 0) return void 0;
	const match = TYPE_MACRO.exec(text);
	if (match === null) return void 0;
	const start = match.index;
	const without = `${text.slice(0, start)} ${text.slice(start + match[0].length)}`.replace(/\s+/g, " ").trim();
	return { term: `${match[1].toLowerCase()}:${match[2]}`, kind: match[1].toLowerCase() === "folder" ? "dir" : "file", value: match[2].replace(/^"/g, "").replace(/"$/g, ""), without };
}
/**
 * A positive `ext:` term, if any, plus the search string without it. `!ext:` is an
 * exclusion and asserts no type, so it is deliberately not matched.
 */
function readExtTerm(search) {
	const text = String(search);
	const match = EXT_TERM.exec(text);
	if (match === null) return void 0;
	const start = match.index + match[1].length;
	const without = `${text.slice(0, start)} ${text.slice(start + match[0].length - match[1].length)}`.replace(/\s+/g, " ").trim();
	return { value: match[2], without };
}
/**
 * `search` 里被双引号包住的部分是**字面量**：Everything 原样匹配引号内的文本，不会
 * 把它当函数解析。所以 `content:"folder:docs"` 是在正文里找那 11 个字，`"folder:docs"`
 * 是在文件名里找，两者都不构成类型断言。
 *
 * 压测实测（2026-11-09，本机）：不剥引号时 `ext:txt "folder:docs"` 被 E_TYPE_CONFLICT
 * 拦掉、`content:"folder:docs"` 被 E_CONTENT_TYPE_CONFLICT 拦掉——**守卫自己制造了
 * 假阴性**，比它治的病更贵。TYPE_MACRO 与 content 的字面探测都改走这条剥引号后的串。
 *
 * `content*:` 之后的全部内容也是纯文本，一并剥掉，理由同上。
 */
function findUnquotedMacro(text) {
	const source = String(text);
	let inQuote = false;
	let starTail = false;
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (inQuote) continue;
		// content*: 会把后面的一切当纯文本，它之后的 folder:/file: 不构成函数调用。
		if (starTail) continue;
		if (ch === "*" && /(?:^|[\s<>])!?content$/i.test(source.slice(0, i))) starTail = true;
		if (ch !== "f" && ch !== "F") continue;
		const head = /^(file|folder):/i.exec(source.slice(i));
		if (head === null) continue;
		// 前一个字符必须是分隔符，否则是词尾（避免把 xxfolder: 当宏）。
		if (i > 0 && !/[\s<>]/.test(source[i - 1])) continue;
		const valueStart = i + head[0].length;
		let valueEnd = valueStart;
		if (source[valueStart] === '"') {
			// 引号值：folder:"a b" —— 值本身允许带引号，整段算宏的一部分。
			const close = source.indexOf('"', valueStart + 1);
			valueEnd = close === -1 ? source.length : close + 1;
		} else {
			while (valueEnd < source.length && !/[\s<>]/.test(source[valueEnd])) valueEnd += 1;
		}
		const kind = head[1].toLowerCase() === "folder" ? "dir" : "file";
		const rawValue = source.slice(valueStart, valueEnd).replace(/^"/, "").replace(/"$/, "");
		const without = `${source.slice(0, i)} ${source.slice(valueEnd)}`.replace(/\s+/g, " ").trim();
		return { term: `${head[1].toLowerCase()}:${source.slice(valueStart, valueEnd)}`, kind, value: rawValue, without };
	}
	return void 0;
}

/**
 * 类型断言「只留目录」与 `content:` 撞车——两条都是恒空，却都静默归零。
 *
 * Everything 的 `content:` 逐候选文件现读正文，而目录没有正文，所以任何「只留目录」
 * 的断言 AND 上 content:，在**任何磁盘状态下**都是 0 条。实测（本机，2026-11-09）：
 * `folder:docs content:"KEY"` 6 ms 回 0——6 ms 就是「一个文件都没读」，查询在索引层就
 * 被判空；同 scope 换成 `path:docs` 写法 224 ms 才真扫。两个耗时差两个量级，正是
 * 「参数矛盾」与「磁盘上没有」的区别。
 *
 * 最贵的是它长得像正常查询：调用方拿到 0，把它读成「这个目录里没有」，与 file:/
 * folder: 撞车那批修复在治的是同一种病。所以走同一条规则：显式失败，并给出**真能跑通**
 * 的改写。
 *
 * 两个来源分开判：
 *   - 串内宏 folder: 恒空；file: 正相反、恒为真（正文只存在于文件里），不拦；
 *     `!folder:` / `!file:` 是排除、不断言类型，也不拦。
 *   - 参数 type: "dir"：buildSearch 会把它渲染成 folder:，同样恒空。
 *
 * 宏一律走 findUnquotedMacro：引号里的 `folder:docs` 是字面量，不是类型断言，
 * 错把它当宏会把能跑的查询判死——守卫自己制造假阴性比它治的病更贵（实测踩过）。
 */
function readDirectoryAssertion(input, macro) {
	const source = String(input.search);
	const live = findUnquotedMacro(source);
	const dirMacro = macro !== void 0 && macro.kind === "dir" ? macro : void 0;
	// 只有「活的」宏才构成断言；引号里的、content*: 之后的都不算。
	if (dirMacro !== void 0 && live !== void 0 && live.kind === "dir" && !/(^|[\s<>])!\s*folder:/i.test(source)) {
		return {
			source: dirMacro.term,
			// 留下正文过滤器、只去掉类型词：语义从「在目录里找正文」变成「在文件里找正文」，
			// 这正是调用方那句查询真正想要的。
			rewrite: { search: dirMacro.without.length > 0 ? dirMacro.without : "*" }
		};
	}
	if (input.type === "dir") {
		const without = live === void 0 ? source : live.without;
		return { source: 'type: "dir"', rewrite: { search: without.length > 0 ? without : "*" } };
	}
	return void 0;
}
/**
 * An argument error that also carries a machine-readable rewrite, so a caller can
 * fix the call instead of re-reading prose: `error.code` names the rule and
 * `error.hints` holds the exact arguments to send next. Both hints are executed by
 * the tests, so neither can drift away from a query that actually runs.
 */
function argumentError(code, message, hints) {
	// P0-1：工具结果层只渲染 `Error: <message>`，`error.code` 与 `error.hints` 到不了调用方，
	// 于是「按码分支」这条设计等于不存在。把码写进文案前缀，hints 仍作为附加字段保留。
	const error = new EverythingError(`[${code}] ${message}`, code);
	if (hints !== void 0) error.hints = hints;
	return error;
}

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
 * The query worker. `Everything_QueryW` blocks whoever calls it until the SDK
 * answers, so it runs in `lib/components/everything/query-worker.mjs`: a slow query
 * costs a worker, not this event loop.
 *
 * **It is hosted as a child process, not a worker thread** (measured 2026-11-08).
 * `worker.terminate()` cannot interrupt a native call already inside the DLL - the
 * thread exits only once that call returns - so a stuck call keeps holding the
 * SDK's process-wide query lock for the life of the host process, and every later
 * query in that process blocks on it. Reloading the plugin does NOT clear that: a
 * full bundle unload + reload still timed out, while a query from a fresh *process*
 * answered in 15 ms at the same moment. Only a process exit releases the lock, so
 * the worker must live in a process this plugin is allowed to kill.
 */
const WORKER_URL = workerUrl;
const ABORTED_BEFORE = "everything_search was aborted before completion (tool timeout or caller cancellation)";
const ABORTED_WHILE = "everything_search was aborted while the query ran (tool timeout or caller cancellation)";
const WORKER_REPLACED = "everything_search was cancelled because the plugin was reloaded and its query worker replaced; retry the call";
/**
 * Slack between the tool's own budget and the watchdog that must fire first.
 *
 * The watchdog has to win. If the host's tool-call timeout kills the call before
 * the plugin reacts, that lease is never settled, its slot is never released, and
 * the failure surfaces as an opaque host timeout instead of a code the caller can
 * act on. Measured: the host does NOT abort `exec.signal` on timeout, so the abort
 * path alone never fires - the watchdog is the only guaranteed release.
 */
const WATCHDOG_SLACK_MS = 1000;
/** Floor for the watchdog, so a tiny configured budget still leaves room to answer. */
const WATCHDOG_MIN_MS = 1000;

/**
 * One query runtime: the worker entry and the single in-flight slot, kept in an
 * object instead of module scope so two components (two `apply` calls) never
 * settle each other's requests. The global names below act on the most recent
 * `apply`; a query issued before the first `apply` lazily creates one.
 */
function createQueryRuntime() {
	const rt = {
		/** 空闲与在租的子进程（池）。容量由 `slots` 守，见 `acquireWorker`。 */
		workers: new Set(),
		/** 在租子进程 → 它正服务的请求；一个子进程同一时刻只跑一条查询。 */
		leases: new Map(),
		/** 并发闸门：容量取自 caps.concurrency（默认 1，见 `runQueryOn`）。 */
		slots: createSlotLimiter(DEFAULT_CONCURRENCY, MAX_CONCURRENCY),
		/** Consecutive watchdog timeouts; reset by any query that answers. */
		timeoutStreak: 0,
		runQuery: (exec, input, caps) => runQueryOn(rt, exec, input, caps),
		runQueryUnlocked: (exec, input, caps) => runQueryUnlockedOn(rt, exec, input, caps),
		// 对外只有「换掉这个实例的全部 helper」这一种语义：并发之下没有唯一的那个
		// worker 可退，而 reload 要的正是「旧回复一条都别落进新实例」。
		retire: (code, message) => retireAllWorkersOn(rt, code, message),
		replace: () => replaceAllWorkersOn(rt)
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

/**
 * Release an idle worker from this process's event loop, so a warm helper cannot
 * hold `dsh` open after everything else has finished. A request in flight refs it
 * again.
 *
 * `child.channel` is the IPC pipe and refs the loop independently of the child
 * handle, so both have to be released - and both restored before a send, or a
 * reply can arrive with nothing left to keep the loop alive.
 */
function idleWorker(child) {
	try {
		child.channel?.unref?.();
		child.unref();
	} catch {}
}

/** Undo {@link idleWorker} for the duration of one request. */
function busyWorker(child) {
	try {
		child.ref();
		child.channel?.ref?.();
	} catch {}
}

/**
 * Fork one child and register it in the runtime's pool.
 *
 * A forked child gets its own address space AND its own Everything64.dll
 * instance, which is the entire point: a query stuck inside the DLL can be
 * SIGKILLed, and the process-global SDK lock dies with it. A worker thread
 * cannot be killed out of a native call, so that lock would outlive every
 * retry. stdout/stderr are ignored on purpose - this worker only ever speaks
 * over IPC, and a piped stream nobody drains can block the child.
 *
 * 并发也建立在这一条上：SDK 的 `SetSearchW`/`SetMax`/`SetSort` 是**进程级**状态，
 * 所以「一个子进程里同时跑两条查询」永远是错的；并发度只能等于子进程数，见
 * `acquireWorker`（容量由 `rt.slots` 守）。
 */
function forkWorker(rt) {
	const child = fork(fileURLToPath(WORKER_URL), [], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		windowsHide: true
	});
	idleWorker(child);
	const entry = { child };
	child.on("message", (message) => {
		// 没有租约 = 这条回复属于已结算或已退役的租约，丢掉，不许落进下一条请求。
		if (!rt.leases.has(entry)) return;
		if (message.ok === true) settleRequest(rt, entry, { value: message });
		else settleRequest(rt, entry, { error: new EverythingError(message.message ?? "everything_search query failed", message.code ?? "EVERYTHING_QUERY_FAILED") });
	});
	child.on("error", (error) => {
		dropWorker(rt, entry);
		settleRequest(rt, entry, { error: new EverythingError(`everything_search query worker failed: ${error.message}`, "EVERYTHING_WORKER_FAILED", { cause: error }) });
	});
	child.on("exit", (code, signal) => {
		// 主动退役那条路会先结算并摘掉租约，所以这里还留着租约的只可能是**意外退出**；
		// watchdog 杀掉的那条也走这里，但调用方早按自己的错误码结算过了。
		dropWorker(rt, entry);
		if (!rt.leases.has(entry)) return;
		const how = signal === null || signal === void 0 ? `code ${code}` : `signal ${signal}`;
		settleRequest(rt, entry, { error: new EverythingError(`everything_search query worker exited before answering (${how}); the next call starts a fresh one`, "EVERYTHING_WORKER_EXITED") });
	});
	rt.workers.add(entry);
	return entry;
}

/**
 * 租一个空闲子进程；一个空闲的都没有就按需 fork。
 *
 * 并发上限不在这里守：进到这里之前 `rt.slots` 已经发了许可，所以在途租约数永远
 * ≤ 池容量。这个函数只负责「复用空闲的、不够就新建」。
 */
function acquireWorker(rt) {
	for (const entry of rt.workers) {
		if (!rt.leases.has(entry)) return entry;
	}
	return forkWorker(rt);
}

/** 从池子里摘掉一个子进程。不动租约：要不要结算由调用方决定。 */
function dropWorker(rt, entry) {
	rt.workers.delete(entry);
}

/**
 * 结算一个租约：摘租约、把子进程放回空闲（unref）、再 resolve/reject 那一方。
 * 先摘租约再 settle，是为了让此后到达的迟到回复在 `rt.leases.has()` 那一关就被丢掉。
 */
function settleRequest(rt, entry, outcome) {
	const request = rt.leases.get(entry);
	if (request === void 0) return;
	rt.leases.delete(entry);
	if (rt.workers.has(entry)) idleWorker(entry.child);
	if (outcome.error !== void 0) request.reject(outcome.error);
	else request.resolve(outcome.value);
}

/**
 * 缩容后把多出来的**空闲**子进程杀掉：容量从 4 调回 1 时，不该留着 3 个白占内存的
 * helper。在租的一律不碰——它们的查询还在跑。
 */
function pruneWorkers(rt) {
	const idle = [...rt.workers].filter((entry) => !rt.leases.has(entry));
	while (idle.length > rt.slots.limit) {
		const entry = idle.pop();
		dropWorker(rt, entry);
		try {
			entry.child.kill("SIGKILL");
		} catch {}
	}
}

/**
 * Retire the current worker and settle whatever request it was serving, in one
 * place.
 *
 * This is where the child-process hosting earns its keep: `SIGKILL` on Windows is
 * `TerminateProcess`, which is unconditional, so it also takes down a worker that
 * is stuck *inside* `Everything_QueryW` - along with its DLL instance and the SDK's
 * process-global query lock. `worker.terminate()` could not do that (measured: it
 * returned in 6-8 ms while the thread kept posting replies until the native call
 * returned), which is exactly how one bad query used to make every later query in
 * the host process fail.
 *
 * The in-flight promise has to be settled here, and with its own code: dropping
 * the reference alone (what `apply()` used to do) leaves the awaiting call
 * hanging forever with nobody to report it, and an aborted call must not arrive
 * as a replaced worker either. `Promise.race([pending, abortedReply, watchdogReply])`
 * reports whichever rejection lands first, so every caller passes its code in.
 */
function retireWorkerOn(rt, entry, code, message) {
	settleRequest(rt, entry, { error: new EverythingError(message, code) });
	dropWorker(rt, entry);
	try {
		entry.child.kill("SIGKILL");
	} catch {}
}

/** 退役这个实例的全部 helper（reload / 外部 retire）：并发之下会有多条在途被同时结算。 */
function retireAllWorkersOn(rt, code, message) {
	for (const entry of [...rt.workers]) retireWorkerOn(rt, entry, code, message);
}

/** 与 retireAllWorkersOn 同码同文案，只是错误码写成「被替换」，与旧实现保持一致。 */
function replaceAllWorkersOn(rt) {
	for (const entry of [...rt.workers]) retireWorkerOn(rt, entry, "EVERYTHING_WORKER_REPLACED", WORKER_REPLACED);
}

/**
 * 租一个子进程并把请求发出去；返回租约本身和这条请求的 promise。
 *
 * 调用方必须拿着 `entry`：超时与 abort 的退役要精确到这一条租约——旧实现能靠
 * `rt.workerEntry` 指认「那个 worker」，并发之后只有 `entry` 说得清该杀谁、该结算哪条请求。
 */
function askWorker(rt, request) {
	const entry = acquireWorker(rt);
	const pending = new Promise((resolve, reject) => {
		rt.leases.set(entry, { resolve, reject });
		try {
			busyWorker(entry.child);
			// The callback covers a channel that closes between the check above and the
			// write; `rt.leases.has(entry)` keeps a late send failure from rejecting a
			// lease the watchdog or an abort already settled.
			entry.child.send(request, (error) => {
				if (error === null || error === void 0) return;
				if (!rt.leases.has(entry)) return;
				retireWorkerOn(rt, entry, "EVERYTHING_WORKER_FAILED", `everything_search could not reach its query worker: ${error.message}`);
			});
		} catch (error) {
			rt.leases.delete(entry);
			reject(new EverythingError(`everything_search could not reach its query worker: ${error.message}`, "EVERYTHING_WORKER_FAILED", { cause: error }));
		}
	});
	return { entry, pending };
}

/**
 * 并发由「槽位 + 子进程池」提供，不再有一条全序的 `rt.chain`：
 *
 * - `rt.slots` 守住同时在途的查询数（容量 = `caps.concurrency`，默认 1，与旧的单在途
 *   链逐字等价）；
 * - 每条在途查询独占一个子进程（`acquireWorker`）：`SetSearchW`/`SetMax`/`SetSort` 是
 *   进程级状态，同一子进程并发跑两条必然互相踩，所以并发度只能等于子进程数；
 * - 回复归属按**租约**（`rt.leases`）判定，不需要请求 id 表：租约就是那个子进程。
 *
 * 坏查询不会堵住后面的调用：槽位在 `run()` 的 finally 里释放，watchdog 也一定会
 * 结算自己那条租约。
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
	// P2-1：`ext:` 空值语义未定义且静默（实测 default-workspace 回 5、dsh-voice 回 1、
	// tg_run 回 0，而三个目录实有 15 / 6 / 3 个 .md）——既不是「无过滤」，也不报错，
	// 是一个谁也解释不了的数字。Everything 把它当空扩展名处理，所以这里显式拒绝。
	if (/(^|\s)ext:(?=\s|$)/i.test(search)) throw new Error("ext: requires a value: `ext:` with nothing after it is undefined in Everything's syntax (measured: it answers a count that is neither \"no filter\" nor an error) - write ext:md, ext:md;txt, or drop the ext: clause to search every type");
	validateRegexes(search);
	return {
		...args,
		search
	};
}

/**
 * Normalise one `path:` scope down to its static prefix (P0-1).
 *
 * `path:C:\x\*` answers zero matches on the live SDK while `path:C:\x` answers
 * 19: Everything's `path:` is already a prefix match, so a trailing `*` only
 * turns the scope into a string nothing matches - and the old error message
 * recommended exactly that form as a way out. A wildcard in the middle
 * (`C:\a*\b`) is left alone: it is not provably equivalent to anything.
 */
function staticScopePrefix(scope) {
	let current = scope.trim();
	for (;;) {
		// 只剥「分隔符 + 通配」这一种：C:\x\* 是「该目录下全部」，而 C:\a* 是名字前缀
		// 通配，两者语义不同——后者必须原样保留，否则一次前缀匹配会被改成精确目录。
		const next = current.replace(/[*?]+$/, "").replace(/[\\/]+$/, "");
		if (next === current || next.length === 0) return current;
		current = next;
	}
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
		// 先剥掉尾部通配再判存在性：`path:C:\x\*` 实测回 0 条，而 `path:C:\x` 回 19 条。
		const target = staticScopePrefix(scope);
		const trailingWildcard = /[*?]+[\\\\/]*$/.test(scope);
		// 存在性分三种：固定路径照旧整串校验；尾部通配归一后只剩「名字前缀」，没有可 stat
		// 的对象，只要求它的父目录存在——父目录也不存在就是路径写错，必须当场报错，不许再
		// 伪装成「索引里没有」（P0-1 的后半：旧实现见到 `*` 就跳过全部路径校验）。
		// 中间通配（`C:\\a*\\b`）维持既有契约不校验；连盘符都不存在（`D:` 不在）也不算参数
		// 错误，nearestExistingAncestor 返回空串时按「通配串无从校验」放行。
		// 通配 scope 有两种写法，校验对象不同（P1-1）：
		// ① `dir\*` / `dir\**`（分隔符 + 通配）：归一后是一个**真实目录**，必须存在且是目录；
		// ② `name*`（名字前缀 + 通配）：归一后只是名字片段，磁盘上没有可 stat 的对象，
		//    只能要求它的父目录存在。
		// 旧实现两种都只查父目录，于是 `NoSuchBase-XYZ\*` 只要它的父目录存在就被放行，
		// 一路走到「零命中」兜底文案——把「路径写错」伪装成「索引里没有」。
		const separatorWildcard = /[\\/][*?]+[\\/]*$/.test(scope);
		const parentDir = dirname(target);
		const missing = !/[*?]/.test(scope)
			? !existsSync(target)
			: separatorWildcard
				? target.length > 0 && !/[*?]/.test(target) && !existsSync(target) && nearestExistingAncestor(target).length > 0
				: trailingWildcard && target.length > 0 && !existsSync(parentDir) && nearestExistingAncestor(parentDir).length > 0;
		// 诊断写全 + 显式开关。默认仍抛错，但消息要能自己把自己修好：原始 scope、逐级
		// 上溯到的最近存在父目录、三条出路。只有调用方显式传 pathMustExist:false 才降级
		// 为忽略 scope（由 notes 回报、结果头明写「path ignored」）——静默空结果会把
		// 「路径写错」和「目录里确实没有」混成同一个回答，那正是前几轮在修的反面。
		//
		// 2026-11-11：这里原先是两次确认（pathMustExist:false + 已删除的 allDrives:true），
		// 但中间那个「只传 false」的档位并不落地——它照样抛错，只是换成一句
		// 「请再补另一个参数」。一个不产生任何行为的档位只会让调用方多失败一次，
		// 所以二次确认整体删除，pathMustExist:false 自己就是授权。
		// 默认（true / 不传）的报错路径一字不动，那个是真门禁。
		const wantsIgnore = input.pathMustExist === false;
		if (missing && !wantsIgnore) {
			const ancestor = nearestExistingAncestor(target);
			throw argumentError("E_SCOPE_DROPPED", `path does not exist: ${scope}${ancestor.length > 0 ? ` (nearest existing parent: ${ancestor})` : ""}; check the folder exists, or omit path: to search the whole index - or set pathMustExist: false to ignore the scope.`, ancestor.length > 0 ? { rewrite: { path: ancestor }, alternative: { pathMustExist: false } } : { rewrite: { pathMustExist: false } });
		}
		const ignoreMissing = missing && wantsIgnore;
		// scope 指向一个文件时 `path:` 恒为 0 命中：实测 `*.md` + path=真实 .md 文件，拼出来的
		// 是 `path:C:\...\清单.md\`（给文件补了尾分隔符），结果一条都没有、且毫无提示。
		// 这是参数用错（path 只收目录），不是路径不存在，所以与 missing 分开报，也照旧给出路。
		// 带分隔符的通配（`dir\*`）归一后已有确定的目录，同样要过「是目录不是文件」这一关，
		// 否则 `README.md\*` 这类写法仍会静默归零。
		if (!missing && (!/[*?]/.test(scope) || separatorWildcard)) {
			const stat = statSync(target, { throwIfNoEntry: false });
			if (stat !== void 0 && stat.isFile()) {
				throw new Error(`path must be a directory, not a file: ${target}; path: is a prefix scope, so a file path matches nothing - pass the parent directory (${dirname(target)}) and put the file name in search, or narrow with ext: instead`);
			}
		}
		if (ignoreMissing) {
			if (notes !== void 0) notes.ignoredScope = scope;
		} else {
			// P2-1：范围真的生效时也回报一声。零命中的措辞要据此区分「这个目录里没有」与
			// 「索引里没有」——前者不能拿来断言文件不存在，实测 `*.md` + 一个确有 .md 的目录
			// 也回 0 条（索引没覆盖该卷），两种成因不该印成同一句话。
			if (notes !== void 0) notes.scopeApplied = scope;
			// 只规范化 scope 自己的分隔符，input.search 原样保留。
			const normalized = target.replace(/\//g, "\\");
			// 补尾分隔符，让 Everything 匹配目录内容而非目录名本身；已以分隔符结尾或已含通配的 scope 原样使用。
			// P0-1：`name*` 与 `dir\*` 归一后不是一回事——`dir\*` 补尾分隔符才等价于直连目录，
			// 而名字前缀形态补了分隔符就变成「这个精确目录」，把 `dsh-voice-s*` 逼回 0 条（实测
			// 直连 `dsh-voice-suite-main` 有 1 个 .md）。名字前缀不补分隔符，交给 path: 自己的
			// 前缀匹配；分隔符形态照旧补，保住「该目录下全部」的语义。
			const namePrefixWildcard = /[^*?\\/][*?]+[\\/]*$/.test(scope);
			// 中间通配（`C:\a*\b`）折叠不到底，原样保留、也不补尾分隔符——与旧契约一致。
			const keepsMidWildcard = /[*?]/.test(normalized);
			const scoped = /[\\]$/.test(normalized) || keepsMidWildcard || namePrefixWildcard ? normalized : `${normalized}\\`;
			// Prepend, never append: content*: turns everything after it into plain text, so a
			// path: scope appended at the end would be matched as literal text instead of scoping
			// the search - measured: that is how a scoped content*: query still reached the whole
			// index and timed out. With this order the path argument also counts as narrowing.
			terms.unshift(`path:${quotePathScope(scoped)}`);
		}
	}
	// type 渲染成 Everything 自己的类型词：file → file:、dir → folder:（实测
	// node_modules folder: 393 条目录、node_modules file: 2 条文件，对着全量 33307；
	// 回包的 folder 布尔与之同源，零新 SDK 绑定）。串里已带 file:/folder: 就不再
	// 追加——两个词会 AND 成 0（实测 *.dll file: folder: 是 0 条），静默归零比报错
	// 贵，所以把「没追加」做成值字段回报、由结果头写明，不许拼字符串混进 header。
	//
	// 先说清楚「走不走得到」，别让下一个人（或下一次审阅）把它当死代码删掉：
	//   - 工具面走不到。execute 在调用本函数之前就先把 type 撞车判成 E_TYPE_AMBIGUOUS，
	//     所以正常一次 everything_search 永远不会进这个 if。
	//   - 但本函数是纯函数，被 test/verify.mjs 直接调用（按文件路径 import，不经过
	//     包名解析），那里真的会进这个 if。删掉本行，那条断言立刻红（实测：在工具面
	//     以为它是死的、删掉后 219 passed / 1 failed，失败信息里 skippedType 显示
	//     undefined）。所以「工具面不可达」不等于「代码是死的」。
	//   - 本分支也是 buildSearch 作为导出（lib/index.js 与 package.json 的 "./*" 都
	//     放了它）时唯一的告知途径。目前本机没有第二个调用者——已扫过 dsh-plugin、
	//     .dsh、DSH checkout，零命中，包也未发布 npm——所以别把这条当既有用户需求，
	//     它是一条为「绕过 execute 直接调用」留的接口。
	const typeTerm = input.type === void 0 ? "" : (TYPE_FILTERS.get(input.type) ?? "");
	if (typeTerm.length > 0) {
		if (/\b(?:file|folder):/i.test(input.search)) {
			if (notes !== void 0) notes.skippedType = input.type;
		} else {
			terms.push(typeTerm);
		}
	}
	// Prepend, never append: content*: turns everything after it into plain text, so an
	// exclusion appended at the end would be matched as literal text instead of being
	// applied - the trash and system folders would silently come back into the results.
	for (const rule of excludeRules) terms.unshift(`!path:${quotePathScope(rule)}`);
	return terms.join(" ");
}


/**
 * Query Everything through a leased child process, collecting `caps.maxResults`
 * results from `caps.offset`. The native call itself runs in
 * `lib/query-worker.mjs`, so this event loop stays free while a query runs.
 *
 * 并发闸门就是这里：`caps.concurrency`（默认 1）决定这个实例上能同时有几条在途查询。
 * 每次调用都 `resize` 一次，所以同一实例先后用不同并发度是安全的；容量收紧只影响
 * 后续准入，已经在跑的查询不被打断。
 *
 * **排队是有上限的，超了具名失败**：宿主的时间预算是墙钟，覆盖「排队 + 执行」，而插件
 * 自己的 watchdog 只从拿到槽位之后才起算——所以无上限排队等于把宿主的工具超时（一句
 * 没有错误码的 `tool call timed out`）留给自己。排队的窗口取 watchdog 从宿主预算里让出
 * 的那一段（默认 1s），用满就抛 `EVERYTHING_BUSY`，把「现在忙、稍后重试」说清楚。
 */
async function runQueryOn(rt, exec, input, caps) {
	rt.slots.resize(caps?.concurrency);
	const budgetMs = Number.isFinite(caps.timeoutMs) ? caps.timeoutMs : SEARCH_TIMEOUT_MS;
	const queueWaitMs = Math.max(0, Math.min(WATCHDOG_SLACK_MS, budgetMs - WATCHDOG_MIN_MS));
	const outcome = await rt.slots.runWithin(queueWaitMs, async () => {
		try {
			return await runQueryUnlockedOn(rt, exec, input, caps);
		} finally {
			pruneWorkers(rt);
		}
	});
	if (outcome.admitted === false) {
		throw new EverythingError(`everything_search is already running ${rt.slots.active} queries (concurrency ${rt.slots.limit}, queue wait ${queueWaitMs}ms): this call gave up instead of waiting into the host's tool budget - retry shortly, raise concurrency, or send fewer searches per step`, "EVERYTHING_BUSY");
	}
	return outcome.value;
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
	// Both releases end in retireWorkerOn, which SIGKILLs that one child: that is
	// what takes the stuck native call - and the SDK's process-global query lock it
	// holds - down with it. This is not "cancellable in flight" and is not claimed
	// as such; it is "the process holding it is disposable". 并发之后退役必须精确到
	// 这一条租约，否则会误杀别的在途查询。
	const { entry, pending } = askWorker(rt, request);
	pending.catch(() => void 0);
	const canListen = typeof exec.signal.addEventListener === "function";
	// The watchdog is the one release that does not depend on the host. Measured:
	// the host does NOT abort `exec.signal` when it times a tool call out, so with
	// only the abort branch that lease would never settle, its slot never released,
	// and every later query would queue behind it forever - the original failure. It
	// must also fire *before* the host's own budget, or the caller gets an opaque
	// "tool call timed out" instead of a code it can act on.
	const budget = Math.max(WATCHDOG_MIN_MS, (Number.isFinite(caps.timeoutMs) ? caps.timeoutMs : SEARCH_TIMEOUT_MS) - WATCHDOG_SLACK_MS);
	let onAbort;
	let watchdog;
	const abortedReply = new Promise((_resolve, reject) => {
		// One exit, one code per cause: `retireWorkerOn` settles that lease too, so
		// `pending` and this promise agree on whichever reason lands first and the
		// caller is never handed a WORKER_REPLACED for an abort.
		const giveUp = (code, message) => {
			retireWorkerOn(rt, entry, code, message);
			reject(new EverythingError(message, code));
		};
		onAbort = () => giveUp("SEARCH_ABORTED", ABORTED_WHILE);
		if (canListen) exec.signal.addEventListener("abort", onAbort, { once: true });
		watchdog = setTimeout(() => {
			rt.timeoutStreak += 1;
			// No runtime lockout on purpose: every query runs in its own forked child with its own
			// Everything64.dll instance, so a SIGKILLed child takes that process-wide query lock
			// down with it - the host process is never left holding it. The streak stays a hint.
			//
			// 文案只要两件事：为什么停、下一步粘什么。其余（SDK 锁原理、容器能力矩阵、
			// 「一条查询只有一次机会」）归 README 与工具 description，超时那一刻没人读长文。
			// 上一版 1146 字符 → 这一版 ~200。
			const rawSearch = String(input.search ?? "").replace(/\s+/g, " ").trim();
			const hasScope = NARROWING_TERM.test(rawSearch) || (input.path !== void 0 && String(input.path).trim().length > 0);
			const nextStep = hasScope
				? `already scoped - add (ext:, dm:, size:) maybe use a smaller path:`
				: `no scope - pass path, maybe add (path:, ext:, size:) and rerun`;
			giveUp("EVERYTHING_QUERY_TIMEOUT", `${budget}ms timeout, query killed (content:/container-filenames: read files off disk; unscoped they hit the whole index). Search: "${rawSearch.length > 80 ? `${rawSearch.slice(0, 80)}...` : rawSearch}" - ${nextStep}.`);
		}, budget);
	});
	try {
		const reply = await Promise.race([pending, abortedReply]);
		rt.timeoutStreak = 0;
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
		// P2-1：生效的范围也要带出去，formatOutput 据此把零命中限定在「这个目录里」。
		if (scopeNotes.scopeApplied !== void 0) value.scopeApplied = scopeNotes.scopeApplied;
		if (scopeNotes.skippedType !== void 0) value.typeIgnored = scopeNotes.skippedType;
		if (truncated) value.nextOffset = offset + items.length;
		// 前缀压缩只对 `path`（含缺省）开启。依据是同目录相邻的程度（实测 500 条：
		// path 90 段、name 151 段、size 166 段，目录唯一数 89）：
		//   - path：顺序等于目录序，压缩几乎零损失，省 49%，读起来是整块整块的；
		//   - name：确实省 41.8% 字符，但文件名首字母交替会让目录行来回切——8 条结果
		//     能产生 6 个目录行（含单独成行的 `..\`），行数从 8 涨到 14，阅读更费劲；
		//   - size / dateModified / dateCreated：排行榜用途，行序本身就是答案。
		// 缺省 sort 现在就是 path（见 sdk.DEFAULT_SORT），所以这里用同一口径判断：
		// 不传 sort 时 `request.sort` 是 undefined，必须按 path 处理，否则默认页反而
		// 不压缩——那正是「默认最该省的地方不省」。
		if (items.length > 0 && (request.sort ?? DEFAULT_SORT) === "path") value.compacted = true;
		// 有值才赋值，与上面两条同一个理由：值为 undefined 的键会被 JSON.stringify 丢掉。
		if (typeof caps.maxResultsClampedFrom === "number" && Number.isFinite(caps.maxResultsClampedFrom)) value.maxResultsClampedFrom = caps.maxResultsClampedFrom;
		// P0-2：与 maxResultsClampedFrom 同一条口径——越界必须留痕，且只在有值时才赋值
		// （值为 undefined 的键会被 JSON.stringify 丢掉，严格往返比对就不相等）。
		if (typeof caps.offsetClampedFrom === "number" && Number.isFinite(caps.offsetClampedFrom)) value.offsetClampedFrom = caps.offsetClampedFrom;
		return value;
	} finally {
		if (canListen) exec.signal.removeEventListener("abort", onAbort);
		clearTimeout(watchdog);
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
			description: 'What to search, one expression. Everything syntax passes through: path:<dir>, ext:<type>, size:>10mb, dateModified:thisweek, folder:, content:"exact phrase", regex:"^IMG_" (double-quoted = pattern may hold spaces), | = union (each side is evaluated independently), ! = exclude, <a|b> = group. Archives: zipfilename:/container-filenames: = name inside archive. content: and these both read files off disk, so scope them (path:, ext:, size:) or expect the time budget to cut the query off. Coverage: zip = names + bodies; 7z, rar = names only; tar, tar.gz = neither. `type:` is not an Everything function - use the type parameter. Required.',
		},
		path: {
			type: "string",
			// P0-1：尾部通配的三种写法（dir\*、dir\**、name*）现在都归一到静态前缀，
			// 描述必须照实说，否则模型会以为 name* 另有语义。
			description: "Dir to search in → rendered as path: term, prefix match, trailing wildcard dropped. Cheapest way to shrink a search. Omit = all indexed volumes."
		},
		pathMustExist: {
			type: "boolean",
			description: 'Keep true (default): a missing path is an error naming the nearest existing parent. false = accept the dropped scope and search the whole index instead; the header then says "path ignored".'
		},
		maxResults: {
			type: "number",
			description: `Hits per page (1-${MAX_RESULTS_CAP}, default ${caps.maxResults}). Header reports any clamp.`
		},
		offset: {
			type: "number",
			// P1-1：口径与实现同步——负数不再静默钳成第 0 页，而是参数错误（旧文案写
			// "negatives clamp to 0"，与 maxResults 的越界待遇也不对称）。
			description: `Page start: pass the nextOffset the last page printed. Omit for page 1.`
		},
		exclude: {
			type: "string",
			description: `Dirs to skip: ;-separated fragments → !path: terms. Defaults to ${DEFAULT_EXCLUDE_PATHS.join("; ")}; "" = include back.`
		},
		sort: {
			type: "string",
			description: "Column order: name, path, size, dateModified, dateCreated. Default path asc (= folder-grouped, compact pages); keep one key while paging. name = filename is the question; size/dateModified = biggest/newest few."
		},
		descending: {
			type: "boolean",
			// 与 sdk.sortValueFor 同口径：sort 缺省时按 DEFAULT_SORT(path) 处理，无条件加降序偏移。
			// 旧文案写「sort 缺省时忽略」，与实现、与 prompt 段正好相反，是这条唯一的实质缺陷。
			description: "Reverse that order: pair it with sort:dateModified for newest first, or with sort:size for the largest files first."
		},
		countOnly: {
			type: "boolean",
			description: "Report the total match count instead of items. Use it to size a query before spending a page on paths."
		},
		type: {
			type: "string",
			description: "Keep only files or only folders (file, dir). A separate parameter, not an Everything function - writing `type:dir` inside search matches a literal name and returns nothing (the E_TYPE_INLINE error catches it)."
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
		// 约束类规则（参数错误、索引未加载、钳位、撞车）一律归运行时输出与各参数 description，
		// 别在工具 description 里再抄一遍：同一句话说两遍只会漂。
		//
		// 2026-11-10：上一版正文违反了上面这条自己定的规矩——第 1-3 步的三步法与工具 description
		// 的 "Narrow first, then read text: (1)(2)(3)" 是同一件事的两次陈述，且两处标注的算子集合
		// 还不一致（prompt 漏了 dm:，desc 漏了 regex:）。同一规则写两遍，漂移只是时间问题，
		// 所以这里只留【分工】与【汇报】，三步法交给 description 那份唯一来源。
		// 另：「开工前先搜一次」由强制改为例外触发——一个文件搜索任务本来就不需要先做探索性查询，
		// 强制指令被反复违反，比没有这条指令更糟（会训练模型忽略 prompt）。
		text: `找文件：不知道名字/位置 → 先搜再猜再问再打桩。已知机器上可能已有 → 开工前先探一遍，否则不必。
分工：按名 = 本工具；已知文件精读 = grep；工作区路径匹配 = glob；索引可用性 = everything_status。
并发：同一时刻只有 ${caps.concurrency} 条查询在跑，多的会排队；排队超过约 1 秒就回 EVERYTHING_BUSY。看到它就少发几条、或分两步再发，别把同一批查询连着重试。
Report in three steps: header, paths verified with read or glob, paging; keep unverified as "candidate, unverified".`,
	});
	const tool = defineTool({
		name: "everything_search",
		description: `Usage: find files by NAME, all indexed volumes. exact → wildcard.
Principle: 1 query 1 intent. order: exact → (path:, ext:, size:) → wildcard.
Narrow before read: index-only terms + countOnly = size the set; path: = cheapest cut; then content:"kw". Cost: content: ≈1ms/candidate, da: ≈200ms/file (both read disk; ~7000 = 7s budget). Free: ext:, size:, folder:, dc:, dm:. parent: needs the FULL parent path.
Concurrency: at most ${caps.concurrency} queries run at once; extra calls queue briefly, then fail with EVERYTHING_BUSY - send fewer per step instead of retrying the same batch.
Semantics: per-param descriptions define each. paging: keep sort+search fixed w/ nextOffset (1 page = 1 order). mtime = epoch ms.
Report: quote header as-is → verify paths by read/glob → say how to page. sample-only = "candidate, unverified".
Scope: default exclusions ${DEFAULT_EXCLUDE_PATHS.join("; ")}; exclude:"" = include back.`,
		parameters: buildParameters(caps),
		timeoutMs: caps.timeoutMs,
		// 声明并发安全：本工具只读，且每条查询各占一个 forked 子进程（SDK 的 SetSearchW/SetMax/
		// SetSort 是进程级状态），所以宿主可以把同一批里的多条 everything_search 放进它的滚动池
		// 一起跑。同时在途的上限由本插件的 concurrency 闸门守，超出的在插件内 FIFO 排队（排队不
		// 计入超时预算）。宿主侧只认精确的 true，参数校验不过会直接判为独占（fail-closed）；
		// 不声明这一项 = 宿主按 exclusive 串行执行，与池容量无关。
		isConcurrencySafe: () => true,
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
					scopeApplied: { type: "string" },
					typeIgnored: { type: "string" },
					maxResultsClampedFrom: { type: "number" },
					offsetClampedFrom: { type: "number" },
					compacted: { type: "boolean" }
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
			// 越界不静默：钳位记下原值，结果里写明「已从 N 调整」。否则 `maxResults: 0`
			// 会被读成「传 0 就是不要结果」，而实际回了一条。
			const clampedFrom = input.maxResults !== void 0 && Number.isFinite(requestedMaxResults) && Math.floor(requestedMaxResults) !== maxResults ? requestedMaxResults : void 0;
			// P1-1：负数 offset 不许静默按 0。`maxResults` 的四个越界值都会在结果头写明被钳位，
			// offset 却一声不响地变成第 0 页——同一类越界两种待遇。schema 语义本来就是
			// `offset >= 0`（页起点），所以这里按参数错误报；clampOffset 仍然只管上界与直接
			// 调用 runQuery 的老调用方（实测 2^32 会静默回绕到第 0 页）。
			if (input.offset !== void 0 && Number(input.offset) < 0) {
				throw new Error(`offset must be >= 0: got ${Number(input.offset)}; offset is the page start (0 is the first page), so a negative value is an argument error instead of a silent clamp - drop offset for the first page, or pass maxResults to size a page`);
			}
			// Same clamp as runQueryUnlocked, one implementation (clampOffset): SetOffset
			// takes a uint32, and 2^32 wrapped back to page 0 silently (measured).
			const offset = clampOffset(input.offset);
			// P0-2：offset 越过 32 位上限时不许静默钳位。maxResults 越界会在结果头写明「已从 N 调整」，
			// offset 越界却一声不响地变成 4294967295（实测 offset:4294967296 就是这样回的），调用方读到的是
			// 「页越界」而不是「你传的值被改了」。记下原值，交给 formatOutput 在头部说明；判定复用 clampOffset，
			// 正常值（含负数的前置报错分支）一个字节都不变。
			const offsetClampedFrom = input.offset !== void 0 && Number.isFinite(Number(input.offset)) && clampOffset(input.offset) !== Math.floor(Number(input.offset)) ? Number(input.offset) : void 0;
			const exclude = parseExclude(input.exclude);
			// 白名单只有 SORT_VALUES 一份；近邻算法放 sdk 侧紧邻它，两处不会漂。不认识的取值
			// 给一个近亲（`mtime` → `dateModified`），实在不像就只列白名单——瞎猜一个键比列
			// 白名单更贵：模型会照着猜错的那个再试一遍。参数组合/取值都只在 execute 报。
			if (input.sort !== void 0 && !SORT_VALUES.has(input.sort)) {
				const suggestion = closestSortKey(input.sort);
				throw new Error(`sort must be one of ${[...SORT_VALUES.keys()].join(", ")}${suggestion === void 0 ? "" : ` - did you mean "${suggestion}"?`} (keys are case-sensitive; any other value is rejected)`);
			}
			// P1：本工具其余参数名被写进 search。它们不是 Everything 的函数，串里那几个字符
			// 只会当字面查询词参与 AND——实测 `node_modules descending:true` / `offset:10` /
			// `maxResults:5` / `exclude:...` / `pathMustExist:false` /
			// `countOnly:true` 全部 463 → 0 条。同一条规则：参数用错不许伪装成空结果。
			const paramHit = SEARCH_PARAM_NAMES.find((name) => new RegExp(`(^|[\\s<>|])${name}:`, "i").test(String(input.search ?? "")));
			if (paramHit !== void 0) {
				const paramRe = new RegExp(`(^|[\\s<>|])${paramHit}:("[^"]*"|[^\\s]*)`, "i");
				const paramMatch = paramRe.exec(String(input.search));
				const paramWithout = `${String(input.search).slice(0, paramMatch.index)} ${String(input.search).slice(paramMatch.index + paramMatch[0].length)}`.replace(/\s+/g, " ").trim();
				const paramKept = paramWithout.length > 0 ? paramWithout : "*";
				throw argumentError("E_PARAM_INLINE", `${paramHit}: inside search is not an Everything function - it is this tool's separate "${paramHit}" parameter, so the term is matched as a literal text and returns nothing whatever the disk holds (measured: 463 results become 0). Rewrite: pass it as the parameter ({ search: "${paramKept}", ${paramHit}: <value> })`, {
					rewrite: { search: paramKept }
				});
			}
			// type 的白名单校验与 sort 同层、同理由：本宿主的值 schema DSL 不收 enum，取值只能
			// 在 execute 拦。合法值就两个，不做近似建议，报错直接把两个列出来。
			if (input.type !== void 0 && !TYPE_FILTERS.has(input.type)) throw new Error(`type must be one of ${[...TYPE_FILTERS.keys()].join(", ")}`);
			// type 与串内 file:/folder: 撞车也只在这里报：两个类型词 AND 成 0（实测
			// *.dll file: folder: 是 0 条），旧行为静默跳过、只在结果头写一句，调用方
			// 把「参数自相矛盾」读成「索引里没有」。buildSearch 的跳过分支原样留着供
			// 直接调用，工具面走不到它。
			// 类型断言只能有一个来源：参数 type、串内 file:/folder: 宏、以及隐含「文件」的 ext:。
			// 任意两条 AND 起来就是恒空——实测 `*.dll file: folder:` 0 条、`folder:doc ext:txt`
			// 0 条、`type: dir` + `ext:txt` 0 条；旧行为一律静默回 0，调用方把「参数自相矛盾」
			// 读成「索引里没有」。这里一次判死，并把可执行改写塞进文案与 error.hints。
			const typeMacro = readTypeMacro(input.search);
			const extTerm = readExtTerm(input.search);
			// `type:` 写进 search 是纯误用：它不是 Everything 的函数，串里那几个字只会被当成
			// 字面文件名，于是 `node_modules type:dir` 静默回 0 条（压测实测）。调用方把它
			// 读成「磁盘上没有」，正是 file:/folder: 撞车那批修复在治的同一种病：参数矛盾
			// 不许伪装成空结果。这里显式判死并给出可执行改写，不改写成「自动纠错」——静默
			// 转换会让真的存在一个叫 `type:dir` 的文件时永远搜不到，只是把静默换个方向。
			const inlineType = TYPE_INLINE.exec(String(input.search ?? ""));
			if (inlineType !== null) {
				const rawValue = inlineType[1].replace(/^"/, "").replace(/"$/, "");
				const lowerValue = rawValue.toLowerCase();
				const stripped = `${String(input.search).slice(0, inlineType.index)} ${String(input.search).slice(inlineType.index + inlineType[0].length)}`.replace(/\s+/g, " ").trim();
				// search 是必填参数，空串既跑不了也不表达「只要目录」；落点用已文档化的 `*`。
				const kept = stripped.length > 0 ? stripped : "*";
				if (lowerValue !== "dir" && lowerValue !== "file") {
					throw argumentError("E_TYPE_BAD_VALUE", `type:${rawValue} inside search asserts no valid type: the type filter only accepts dir or file, and Everything has no native type: function, so the term is matched as a literal file name and returns nothing whatever the disk holds - pass the type parameter instead ({ type: "dir", search: "${kept}" } or { type: "file", search: "${kept}" })`, {
						rewrite: { type: "dir", search: kept },
						alternative: { type: "file", search: kept }
					});
				}
				// 与参数 type 同时出现：两个类型断言 AND 成 0，比单纯误用更具体，单独报码，
				// 让调用方能按码分支（E_TYPE_INLINE 是写法错，E_TYPE_AMBIGUOUS 是给了两次）。
				if (input.type !== void 0) {
					throw argumentError("E_TYPE_AMBIGUOUS", `type is given twice - once as the parameter (type: "${input.type}") and once inside search (type:${rawValue}); they AND to zero results, so the search would match nothing instead of finding files - drop the term from search to let the parameter apply ({ type: "${input.type}", search: "${kept}" })`, {
						rewrite: { type: input.type, search: kept }
					});
				}
				throw argumentError("E_TYPE_INLINE", `type:${rawValue} inside search is not an Everything function - it is this tool's separate "type" parameter, so the whole term is matched as a literal file name and returns nothing whatever the disk holds. Rewrite: pass it as the parameter ({ type: "${lowerValue}", search: "${kept}" })`, {
					rewrite: { type: lowerValue, search: kept }
				});
			}
			// P0：`sort:` 是 Everything 自己的原生排序函数，写进 search 会被 SetSort 接受。
			// 而 SetSort 是进程级全局状态（query-worker.mjs 里同一次请求先 SetSort 再 SetMax），
			// 于是串内的 `sort:size` 会静默盖掉 sort / descending 两个参数——实测
			// `node_modules sort:size` + `descending: true` 拿到的是升序，条数与路径全对，只有
			// 顺序错。这比 type: 那类归零更贵：归零看得见，错序把「参数没生效」伪装成「生效了」。
			// 两个 sort: 同现时后者胜出，同样无声。只报不自动摘除：`sort:` 本身是合法的
			// Everything 语法，自动删掉等于替调用方改写查询意图。
			const inlineSort = INLINE_SORT.exec(String(input.search ?? ""));
			if (inlineSort !== null) {
				const sortValue = inlineSort[1].replace(/^"/, "").replace(/"$/, "");
				const sortStripped = `${String(input.search).slice(0, inlineSort.index)} ${String(input.search).slice(inlineSort.index + inlineSort[0].length)}`.replace(/\s+/g, " ").trim();
				const sortKept = sortStripped.length > 0 ? sortStripped : "*";
				// 同时给了 sort/descending 参数：这是两个来源争同一个全局状态，必须有码可分。
				if (input.sort !== void 0 || input.descending !== void 0) {
					throw argumentError("E_SORT_AMBIGUOUS", `sort is given twice - inside search (sort:${sortValue}) and as the parameter (${input.sort !== void 0 ? `sort: "${input.sort}"` : ""}${input.sort !== void 0 && input.descending !== void 0 ? ", " : ""}${input.descending !== void 0 ? `descending: ${input.descending}` : ""}); Everything's SetSort is process-wide state, so whichever lands last silently wins and the other is ignored with no error - drop the term from search to let the parameter apply ({ search: "${sortKept}"${input.sort !== void 0 ? `, sort: "${input.sort}"` : ""}${input.descending !== void 0 ? `, descending: ${input.descending}` : ""} })`, {
						rewrite: { search: sortKept, ...(input.sort !== void 0 ? { sort: input.sort } : {}), ...(input.descending !== void 0 ? { descending: input.descending } : {}) }
					});
				}
				throw argumentError("E_SORT_INLINE", `sort:${sortValue} inside search is Everything's native sort function, not a filter - it changes the ORDER of results and never narrows them, so it silently overrides the sort parameter (Everything's SetSort is process-wide state) while the result count looks correct. Rewrite: pass the order as a parameter ({ search: "${sortKept}", sort: "<name|path|size|dateModified|dateCreated>" })`, {
					rewrite: { search: sortKept }
				});
			}
			// P1-1：串内自相矛盾（两个类型宏、folder: 配 ext:）比「参数 × 串」更具体，必须先让
			// 下面两条判死；否则 `folder:doc ext:md` + type:dir 会被这里抢先报，而它的首选改写
			// { type: "dir", search: "ext:md" } 正好又撞 E_TYPE_CONFLICT（压测实测：照着改写
			// 立刻再失败一次）。两个门控都只做「让路」，不改任何一条既有文案。
			if (typeMacro !== void 0 && input.type !== void 0 && !(typeMacro.kind === "dir" && extTerm !== void 0) && !/\b(?:file|folder):/i.test(typeMacro.without)) {
				const keptRaw = typeMacro.without.length > 0 ? typeMacro.without : typeMacro.value;
				// 改写必须自身合法：保留 type: "dir" 时若串里还剩 ext:，照着改写会立刻再撞
				// E_TYPE_CONFLICT，所以先把 ext: 摘掉；摘空则用 `*`（type:dir + `*` 正是「只要子目录」）。
				const keptExt = input.type === "dir" ? readExtTerm(keptRaw) : void 0;
				const kept = keptExt === void 0 ? keptRaw : (keptExt.without.length > 0 ? keptExt.without : "*");
				throw argumentError("E_TYPE_AMBIGUOUS", `type cannot be combined with a search that already carries file: or folder: - two type terms AND to zero results, so the search would match nothing instead of finding files; drop type: ${input.type} to keep the search's own file:/folder: filter, or remove that term from search to let type: ${input.type} apply. Rewrite: keep the parameter ({ type: "${input.type}", search: "${kept}" }), or keep the macro ({ search: "${String(input.search)}" })`, {
					rewrite: { type: input.type, search: kept },
					alternative: { search: String(input.search) }
				});
			}
			// P1-1：两个类型宏撞车与 type 参数是否同时出现无关，去掉 input.type 门控——
			// 否则「两个宏 + type」会从三条判死的缝里漏过去，静默归零。
			//
			// 2026-11-10 修正：原判据是「去掉第一个宏后还剩不剩 file:/folder:」，把 `|`
			// 两侧当成 AND 判死。实测 Everything 的 `|` 是**并集**、两侧各自独立求值：
			//   folder:docs = 145, folder:notes = 46
			//   folder:docs | folder:notes = 191   （恰好 145+46，连跑两次稳定）
			//   file:readme | folder:docs  = 10414
			// 这是合法的原生用法，拦它属于曲解 Everything。但也不能一律放行：`|` 只切分支，
			// **分支内部仍是 AND**，实测只要任一分支内部冲突，整个表达式就是 0：
			//   folder:docs folder:notes | readme  = 0     （左侧分支内冲突）
			//   folder:docs | folder:notes file:x  = 0     （右侧分支内冲突）
			//   <folder:docs folder:notes> | readme= 10281 （括号把它隔成了独立分支）
			//
			// 判据必须在**原表达式**上按 `|` 切分后逐段数宏，不能靠 `typeMacro.without`：
			// 去掉首个宏后的串（如 `| folder:notes`）已经丢失了「它原本属于哪一段」的信息，
			// 只会得到「剩下的段里还有宏」这个恒真结果——第一版就是这么错的，实测把合法
			// 的并集全判死了（`folder:docs | folder:notes` 照样报错，且消息插值成
			// `[E_TYPE_AMBIGUOUS] 0`，因为变量在错误的模板里求值）。
			// 逐段计数才表达得出「每一段至多一个类型宏」这条真正的约束。
			const TYPE_MACRO_ANY = /\b(?:file|folder):/gi;
			const branchConflictList = String(input.search)
				.split(/\s*\|\s*/)
				.filter((branch) => (branch.match(TYPE_MACRO_ANY) ?? []).length > 1);
			if (typeMacro !== void 0 && branchConflictList.length > 0) {
				const offending = branchConflictList[0].trim();
				throw argumentError("E_TYPE_AMBIGUOUS", `two type macros inside one | branch: "${offending}" - file: keeps files while folder: keeps folders, so those two AND to zero results whatever the disk holds, and that zeroes the whole expression (a | branch is still an AND). Put them in separate branches, or replace both with the type parameter.`, {
					rewrite: { search: String(input.search).split(/\s*\|\s*/).filter((branch) => (branch.match(TYPE_MACRO_ANY) ?? []).length <= 1).join(" | ") || "*" }
				});
			}
			if (typeMacro !== void 0 && typeMacro.kind === "dir" && extTerm !== void 0) {
				// 留 type: dir 的出路必须把 ext: 去掉：改写本身再撞一次就没意义，所以这里取宏的名字，不取去掉宏后的串。
				const kept = typeMacro.value.length > 0 ? typeMacro.value : "*";
				throw argumentError("E_TYPE_CONFLICT", `${typeMacro.term} (folders only) cannot be combined with ext:${extTerm.value} (files only): a folder is never a .${extTerm.value} file, so the two AND to zero results whatever the disk holds - an ext: term already asserts the file type. Rewrite: list the folders ({ type: "dir", search: "${kept}" }), or list the files ({ search: "${String(input.search).replace(TYPE_MACRO, "").replace(/\s+/g, " ").trim()}" })`, {
					rewrite: { type: "dir", search: kept },
					alternative: { search: String(input.search).replace(TYPE_MACRO, "").replace(/\s+/g, " ").trim() }
				});
			}
			if (input.type === "dir" && extTerm !== void 0) {
				// 去掉 ext: 之后可能什么都不剩，此时不能拿空串当 search：search 是必填参数，空串既跑不了、
				// 也不是「只要目录」的意思。压测实测这条改写会直接撞参数校验。落点用已文档化的 `*`——
				// `type: dir` + `*` 正是「不限名字、只要子目录」（实测 3,016 条）。
				const keptDirSearch = extTerm.without.length > 0 ? extTerm.without : "*";
				throw argumentError("E_TYPE_CONFLICT", `type: dir cannot be combined with ext:${extTerm.value} in search: type: dir keeps folders while ext: keeps files, so the two AND to zero results whatever the disk holds - an ext: term already asserts the file type. Rewrite: list the files ({ search: "${String(input.search)}" }), or list the folders ({ type: "dir", search: "${keptDirSearch}" })`, {
					rewrite: { search: String(input.search) },
					alternative: { type: "dir", search: keptDirSearch }
				});
			}
			// type:dir 与 `*.ext` 天然矛盾：`*.exe` 匹配文件名里的扩展名、`folder:` 只要目录，
			// 两者 AND 必为空。此前它静默归零、只给一句通用 widen，调用方会把「参数矛盾」
			// 读成「磁盘上没有 exe」——与 file:/folder: 撞车同一条规则，显式失败更便宜。
			if (input.type === "dir" && /\*\.[\w$]+/.test(input.search)) throw argumentError("E_TYPE_CONFLICT", `type: dir cannot be combined with an extension wildcard (*.ext) in search: folder: keeps directories while *.ext keeps matching file names, so the two AND to zero results whatever the disk holds - an extension wildcard already asserts the file type. Rewrite: list the files ({ search: "${String(input.search)}" }), or list the folders ({ type: "dir", search: "*" })`, { rewrite: { search: String(input.search) }, alternative: { type: "dir", search: "*" } });
			// 参数组合互斥只落在 execute：值域（offset 钳位）下沉到 runQueryUnlocked 是因为
			// 所有调用者都得过；而「countOnly 配正的 offset」只在工具入口这一层算参数错误。
			// 判断用钳后的值，于是 undefined / 0 / 负数 / 小数都不误伤。旧行为是同一个 total
			// 静默返回、truncated 恒 false，等于把参数吞掉——显式失败比静默无效便宜。
			if (input.countOnly === true && offset > 0) throw new Error("countOnly cannot be combined with a positive offset: total is the whole set, not a page, so drop offset to size a query, or drop countOnly to page; the SDK cannot report how many matches remain after an offset, so there is no 'rest after offset' count to hand back.");
			// path 与串内 path: 撞车也只在这里报，与 type 同一条规则、同一个理由：两个 path: 会互相
			// AND，结果恒为空；旧行为是静默跳过 path 参数，调用方把「参数被吞掉」读成「该目录里没有」。
			// buildSearch 里那段跳过分支原样留着（两个 path: 只可能来自直接调用），工具面走不到它。
			if (input.path !== void 0 && String(input.path).trim().length > 0 && /\bpath:/i.test(input.search)) throw new Error(`path cannot be combined with a search that already carries path: - the two would AND to zero results, so the search would match nothing instead of narrowing; drop the path parameter to keep the search's own path: scope, or remove path: from search to let path: ${String(input.path).trim()} apply`);
			// content: 必须配一个收窄项——这是唯一一条「参数本身没写错、却能把工具打死」的取值。
			// Everything 不索引文件正文（voidtools 原话："File content is not indexed. Searching
			// file content will be very slow."），所以 content: 是逐候选文件现读，成本 O(候选数)；
			// 单独出现时候选集就是整个索引。本机实测：3 个候选 17 ms、3695 个 2.6 s、29821 个
			// 31 s，而无作用域时索引里有 1 398 310 个条目，且没有上限。它同时无法通过 SDK 取消
			// （GUI 的进度条取消没有 SDK 对应物），只能杀掉 worker 进程。
			// 要求配一个收窄项，正是 voidtools 自己给的解药："combine the content: search with
			// other search filters"。
			const CONTENT_TERM = /(^|[\s<>])!?content(\*)?:/i;
			// NARROWING_TERM 已提到模块级（超时文案要用同一份），这里不再重复定义——
			// 作用域内再声明一次会遮蔽模块常量，两份正则迟早漂成不同判定。
			const contentMatch = CONTENT_TERM.exec(String(input.search));
			// `folder:`（或参数 type: "dir"）本身是一个"收窄项"，NARROWING_TERM 只认路径类，
			// 所以这一对能顺利过掉上面那道关，然后在索引层恒空归零——最贵的一种"过了校验
			// 却永远搜不到"。它与 type 撞车同属"参数矛盾"，先用同一条规则判死，再走收窄检查：
			// 顺序反过来的话，`folder: content:"x"` 会先被报成"缺收窄项"，把真实原因遮掉。
			const directoryAssertion = readDirectoryAssertion(input, typeMacro);
			if (contentMatch !== null && directoryAssertion !== void 0) {
				// 改写串本身可能含双引号（content:"X"），直接塞进 `{ search: "..." }` 会出现
				// 引号嵌套破损：实测原文案产出的 `{ search: "docs content:"X"" }` 照抄即非法查询。
				// 所以文案里改用单引号包裹（Everything 的 content: 只认双引号，单引号是安全的
				// 展示层包裹），hints.rewrite 仍给真实对象，机器可读那份不受影响。
				const rewriteShown = String(directoryAssertion.rewrite.search).replace(/"/g, '\\"');
				throw argumentError("E_CONTENT_TYPE_CONFLICT", `${directoryAssertion.source} keeps folders while content: reads file bodies: a directory has no body, so the two AND to zero results whatever the disk holds - the query is contradictory, not empty because the files are missing; drop the type assertion, or keep it and give up content: (content: searches files, so file: is the term that composes). Rewrite: search the bodies ({ search: "${rewriteShown}" })`, {
					rewrite: directoryAssertion.rewrite
				});
			}
			// content: 逐候选文件现读正文（Everything 不索引正文），成本 O(候选数)。历史上这里
			// 是「缺收窄项就直接 throw」——那是一道过度的门槛：插件最初的定位是**兜底与规范**，
			// 而不是替调用方决定能不能发这个查询。工具本身已经有更合适的兜底闸门：watchdog
			// 在 timeoutMs - 1000ms（默认 7000ms）到点后用 SIGKILL 杀掉 worker 进程，查询必然
			// 中止并回 EVERYTHING_QUERY_TIMEOUT，机器不会被一条查询长期拖住。
			// 所以这里改成「照跑 + 把代价写进结果」，让超时闸门去兜住真正跑不完的那种，
			// 而不是在参数层先判死刑。注意 content*: 的形态约束保留：星号会把后面整段变成
			// 字面文本，收窄项写在它后面会被当成文字吞掉，这是语法事实、不是成本判断。
			const starFormUnscoped = contentMatch !== null && contentMatch[2] === "*";
			if (starFormUnscoped) {
				const scopedByArg = input.path !== void 0 && String(input.path).trim().length > 0;
				const beforeStar = (scopedByArg ? "path:" : "") + String(input.search).slice(0, contentMatch.index);
				if (!NARROWING_TERM.test(beforeStar)) {
					throw new Error("content*: turns everything after it into plain text, so a narrowing term written after the star is swallowed instead of applied - write the scope first, e.g. ext:md content*:word.");
				}
			}
			// 容器检索（container-filenames: / zipfilename:）与上面 content: 同一类代价——都要
			// 逐一打开候选文件——因此同样不做前置禁止。这里原有一道守卫（2026-11-10 加，理由
			// 是「无 scope 会跑满 7000ms 预算」）已在同日撤除：那个理由恰好证明兜底闸门够用，
			// watchdog 到点 SIGKILL worker 并回 EVERYTHING_QUERY_TIMEOUT，调用方拿到可行动的码，
			// 机器也不会被长期拖住。前置 throw 只是把同一个结局提早一句话，代价是剥夺调用方
			// 自己判断「这 7 秒值不值得等」的机会。插件定位是兜底与规范，不是替调用方否决查询。
			return await runtimeFor(ctx).runQuery(exec, input, {
				...caps,
				maxResults,
				maxResultsClampedFrom: clampedFrom,
				offsetClampedFrom,
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
/**
 * Budget for the one query the status probe runs. Far below the search
 * watchdog on purpose: a probe that waits as long as a search is not a probe.
 */
const QUERY_PROBE_TIMEOUT_MS = 1500;
/**
 * The cheapest search that still proves the whole path: a size filter reads an
 * index-only property, so a healthy worker answers in single-digit ms and the
 * probe never touches a file on disk.
 */
const QUERY_PROBE_SEARCH = "size:>999999999999";

/**
 * The second half of `everything_status`: the index can be loaded while the
 * worker is unusable, and the SDK loaded flag cannot see that difference.
 *
 * Three states are folded in, in this order: a runtime inside its cooldown
 * refuses without paying a budget; a query already in flight already proves the
 * worker answers, so the probe does not queue behind it; otherwise one minimal
 * countOnly query goes through the very runtime a search would use, and its
 * failure is reported instead of being rounded up to ready.
 */
async function probeQueryPath(ctx, caps, exec, base) {
	const runtime = runtimeFor(ctx);
	if (runtime.leases.size > 0) {
		return {
			...base,
			message: "the index is loaded and a query is running right now, so the worker is answering; the probe skipped its own query"
		};
	}
	try {
		await runtime.runQuery(exec, { search: QUERY_PROBE_SEARCH }, {
			...caps,
			maxResults: 1,
			offset: 0,
			exclude: [],
			countOnly: true,
			timeoutMs: QUERY_PROBE_TIMEOUT_MS
		});
		return base;
	} catch (error) {
		const code = typeof (error && error.code) === "string" ? error.code : "EVERYTHING_QUERY_FAILED";
		return {
			...base,
			ok: false,
			code: "EVERYTHING_QUERY_FAILED",
			message: "the index is loaded, but a minimal probe query through the search worker failed (" + code + "), so a search would fail too: " + String((error && error.message) || "").slice(0, 220)
		};
	}
}
function applyStatusTool(ctx, caps) {
	const tool = defineTool({
		name: "everything_status",
		description: `Report whether everything_search can answer right now. Reads the Everything index's loaded flag and the SDK version, then runs one minimal query through the same search worker - so a loaded index with a stuck worker reports not usable instead of ready. ok:true means searches can answer; ok:false carries a code and a one-line reason, and a skipped or cancelled probe never means the index is down. Call it when a search looks unusable or a result came back on an unloaded index.`,
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
			const base = await probeEverything(caps, exec);
			if (base.ok !== true) return base;
			return await probeQueryPath(ctx, caps, exec, base);
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
	// 标了 `.volatile()` 的字段在这里是 cosmokit 的响应式引用（带 get()），与外壳行
	// `apply()` 和宿主 `plainConfig()` 同一口径解包，否则 Number.isFinite(引用) 恒为假，
	// 界面上改的值会被当成「缺键」悄悄退回默认。
	const value = (raw) => (raw !== null && typeof raw === "object" && typeof raw.get === "function" ? value(raw.get()) : raw);
	const requested = Number(value(caps?.maxResults));
	const maxResults = Number.isFinite(requested) ? Math.min(MAX_RESULTS_CAP, Math.max(1, Math.floor(requested))) : DEFAULT_MAX_RESULTS;
	// 与内容面同一条校验：坏预算回退默认，绝不让非整数或越界值走到 AbortSignal.timeout。
	const timeoutMs = resolveBudgetMs(value(caps?.timeoutMs), SEARCH_TIMEOUT_MS);
	// 与 maxResults 同一条口径：越界不静默失败，也不抛错，只是钳进 [1, MAX_CONCURRENCY]。
	// 0 / 负数 / 非数字都落到 1，也就是「单在途」的旧行为。
	const requestedConcurrency = Number(value(caps?.concurrency));
	const concurrency = Number.isFinite(requestedConcurrency) ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(requestedConcurrency))) : DEFAULT_CONCURRENCY;
	return {
		maxResults,
		timeoutMs,
		concurrency,
		everythingDllPath: value(caps?.everythingDllPath),
		autoStart: value(caps?.autoStart) === true
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
	DEFAULT_CONCURRENCY,
	DEFAULT_EXCLUDE_PATHS,
	DEFAULT_MAX_RESULTS,
	formatStatus,
	isClearlyMalformed,
	MAX_CONCURRENCY,
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

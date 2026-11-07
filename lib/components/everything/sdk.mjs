/**
 * @module lib/sdk.mjs
 *
 * Everything SDK bindings plus the constants each binding is paired with,
 * shared by `lib/index.js` (the tool) and `lib/query-worker.mjs` (the native
 * query thread). Exactly one copy: two copies drift, and a drifted request flag
 * reads every path back as an empty string.
 *
 * Every number below was measured on this machine against the shipped
 * `native/Everything64.dll`; the repo carries no SDK header, so none of them is
 * copied from documentation.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { dllPath } from "../../paths.mjs";

/** Default path buffer size in UTF-16 code units for one result path. */
export const PATH_BUF_UNITS = 32768;

/**
 * Everything SDK sort values. Descending is the ascending value plus
 * {@link SORT_DESCENDING_OFFSET}: name 1/2, path 3/4, size 5/6, dateModified
 * 13/14, dateCreated 15/16. Measured: the first result by name ascending is the
 * reverse of the first by name descending, and the ascending tail page is the
 * reverse of the descending head page.
 */
export const SORT_VALUES = new Map([
	["name", 1],
	["path", 3],
	["size", 5],
	["dateModified", 13],
	["dateCreated", 15]
]);

/** Descending is the ascending SDK sort value plus one, measured - not documented. */
export const SORT_DESCENDING_OFFSET = 1;

/**
 * Spellings callers really type for a sort key. Aliases go before edit distance
 * because distance is useless for the commonest miss: `mtime` is eight edits
 * from `dateModified`, so a distance-only guess would never suggest it and the
 * caller would get the plain whitelist back - the same error again.
 */
const SORT_ALIASES = new Map([
	["mtime", "dateModified"],
	["modified", "dateModified"],
	["modifieddate", "dateModified"],
	["date", "dateModified"],
	["created", "dateCreated"],
	["creation", "dateCreated"],
	["filename", "name"],
	["file", "name"],
	["dir", "path"],
	["folder", "path"]
]);

/** Levenshtein distance over two rows; sort keys are short, so no matrix is needed. */
function editDistance(a, b) {
	let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
		}
		previous = current;
	}
	return previous[b.length];
}

/**
 * The whitelisted sort key a caller probably meant, or `undefined` when nothing
 * is close enough. A wrong guess is worse than the plain whitelist: the caller
 * retries with the guess, so the distance threshold stays tight (<= 2 edits) and
 * the aliases are explicit. The whitelist itself is still {@link SORT_VALUES} -
 * this never becomes a second table.
 */
export function closestSortKey(value) {
	if (typeof value !== "string") return void 0;
	const needle = value.trim().toLowerCase();
	if (needle.length === 0) return void 0;
	const aliased = SORT_ALIASES.get(needle);
	if (aliased !== void 0) return aliased;
	let best;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const key of SORT_VALUES.keys()) {
		const distance = editDistance(needle, key.toLowerCase());
		if (distance < bestDistance) {
			bestDistance = distance;
			best = key;
		}
	}
	return bestDistance <= 2 ? best : void 0;
}

/**
 * Everything SDK request flags. Every read stays paired with its flag:
 * FULL_PATH (4) for `Everything_GetResultFullPathNameW` - without it every path
 * reads back as an empty string - SIZE (16) for `Everything_GetResultSize`, and
 * DATE_MODIFIED (64) for `Everything_GetResultDateModified`. All three together
 * are 84.
 */
export const REQUEST_FLAG_FULL_PATH = 4;
export const REQUEST_FLAG_SIZE = 16;
export const REQUEST_FLAG_DATE_MODIFIED = 64;

/** FILETIME epoch (1601-01-01) to the Unix epoch, in milliseconds; one tick is 100 ns. */
export const FILETIME_EPOCH_OFFSET_MS = 11644473600000;

/**
 * Everything SDK `EVERYTHING_ERROR_*` values mapped to the stable error code
 * this tool reports, with a one-line hint. An unrecognized value is passed
 * through as `EVERYTHING_ERROR_<n>` instead of being guessed: a wrong mapping
 * would upgrade a misdirection into a misdiagnosis.
 */
export const EVERYTHING_ERROR_CODES = new Map([
	[1, {
		code: "EVERYTHING_OUT_OF_MEMORY",
		hint: "Everything ran out of memory"
	}],
	[2, {
		code: "EVERYTHING_NOT_RUNNING",
		hint: "Everything is not running: its IPC channel is unavailable"
	}],
	[3, {
		code: "EVERYTHING_REGISTER_CLASS_FAILED",
		hint: "Everything could not register its IPC window class"
	}],
	[4, {
		code: "EVERYTHING_CREATE_WINDOW_FAILED",
		hint: "Everything could not create its IPC window"
	}],
	[5, {
		code: "EVERYTHING_CREATE_THREAD_FAILED",
		hint: "Everything could not create its IPC thread"
	}],
	[6, {
		code: "EVERYTHING_INVALID_INDEX",
		hint: "the result index is out of range"
	}],
	[7, {
		code: "EVERYTHING_INVALID_CALL",
		hint: "the SDK was called in an invalid state"
	}],
	[8, {
		code: "EVERYTHING_INVALID_REQUEST",
		hint: "Everything rejected the IPC request"
	}],
	[9, {
		code: "EVERYTHING_INVALID_PARAMETER",
		hint: "a query parameter was rejected"
	}]
]);

/**
 * Typed search failure. Extends {@link HarnessError} so it carries a stable
 * error code; the tool registry exposes `{ name, code }` on `isError` results.
 */
export class EverythingError extends HarnessError {
	code;
	constructor(message, code, options) {
		super(message, code, options);
		this.code = code;
	}
}

/** Map the SDK last-error value to a typed search failure; unknown values keep their raw number. */
export function describeLastError(lastError) {
	// lastError=0 is the SDK reporting failure without setting a code (the index
	// not being ready is the usual cause), which is not the mapped
	// "no error reported" hint - keep the two apart.
	if (lastError === 0) return new EverythingError("everything_search query failed: the SDK reported failure without setting an error code (lastError=0) - usually the index is not ready yet", "EVERYTHING_ERROR_0");
	const known = EVERYTHING_ERROR_CODES.get(lastError);
	if (known === void 0) return new EverythingError(`everything_search query failed (lastError=${lastError}, unrecognized SDK error code)`, `EVERYTHING_ERROR_${lastError}`);
	return new EverythingError(`everything_search query failed: ${known.hint} (lastError=${lastError})`, known.code);
}

/**
 * The SDK sort value for one request. The SDK keeps the sort as process-wide
 * state, so an omitted `sort` still has to be written back explicitly
 * (Everything's default order is name ascending); otherwise the previous
 * sorted query leaks into this one.
 */
export function sortValueFor(sort, descending) {
	return SORT_VALUES.get(sort ?? "name") + (descending === true ? SORT_DESCENDING_OFFSET : 0);
}

/** The request flags one request needs; `countOnly` decodes no item and sets none. */
export function requestFlagsFor(countOnly) {
	return countOnly === true ? 0 : REQUEST_FLAG_FULL_PATH | REQUEST_FLAG_SIZE | REQUEST_FLAG_DATE_MODIFIED;
}

/** FILETIME buffer to epoch milliseconds; one tick is 100 ns. */
export function filetimeToEpochMs(koffi, buf) {
	// FILETIME 一个 tick 是 100 ns，除 10000 之后并不保证落在整数毫秒上：实测宽通配 500 条里
	// 489 条带小数（例如 1787382272503.4102），宿主判「无损 JSON」时正好不认这种形态，活跑
	// 就报 invalid output: value is not lossless JSON。取整在这里一次做掉——主线程与 worker
	// 共用这一份，别在 worker 里再写一遍。读不到仍是 -1 哨兵（调用方只在 dateOk 时才进来）。
	return Math.round(Number(koffi.decode(buf, "int64")) / 10000) - FILETIME_EPOCH_OFFSET_MS;
}

/**
 * Load Everything64.dll through koffi and bind every SDK entry point this tool
 * calls. Called from a worker thread, so nothing here touches the tool schema
 * or the host: a broken DLL fails the query as `EVERYTHING_SDK_LOAD_FAILED`.
 *
 * @returns the koffi library handle and the bound SDK functions.
 */
/**
 * The DLL path a query or a probe loads: the configured one, else the copy that
 * ships in `native/`. Exported so `lib/status.mjs` reports the very path it
 * probed instead of re-deriving the expression - two copies drift the moment one
 * of them moves.
 */
export function resolveDllPath(config) {
	return config?.everythingDllPath ?? dllPath;
}

export function loadSdk(config) {
	const require = createRequire(import.meta.url);
	const koffi = require("koffi");
	// 局部量另起名：模块级 `dllPath` 来自 `../../paths.mjs`，同名遮蔽会让后来人把它
	// 内联进 `loadSdk` 时变成自己引自己。纯改名，零行为变化。
	const resolvedDllPath = resolveDllPath(config);
	let lib;
	try {
		lib = koffi.load(resolvedDllPath);
	} catch (error) {
		throw new EverythingError(`everything_search could not load the Everything SDK DLL at ${resolvedDllPath} (is it present?)`, "EVERYTHING_SDK_LOAD_FAILED", { cause: error });
	}
	const api = {
		SetSearchW: lib.func("void Everything_SetSearchW(const char16_t *search)"),
		SetMatchPath: lib.func("void Everything_SetMatchPath(bool matchPath)"),
		SetMatchCase: lib.func("void Everything_SetMatchCase(bool matchCase)"),
		SetRegex: lib.func("void Everything_SetRegex(bool regex)"),
		SetMax: lib.func("void Everything_SetMax(uint32 max)"),
		SetOffset: lib.func("void Everything_SetOffset(uint32 offset)"),
		SetSort: lib.func("void Everything_SetSort(uint32 sort)"),
		SetRequestFlags: lib.func("void Everything_SetRequestFlags(uint32 flags)"),
		QueryW: lib.func("bool Everything_QueryW(bool wait)"),
		GetNumResults: lib.func("uint32 Everything_GetNumResults()"),
		GetTotResults: lib.func("uint32 Everything_GetTotResults()"),
		IsFolderResult: lib.func("bool Everything_IsFolderResult(uint32 index)"),
		GetResultFullPathNameW: lib.func("uint32 Everything_GetResultFullPathNameW(uint32 index, char16_t *buf, uint32 size)"),
		GetResultSize: lib.func("bool Everything_GetResultSize(uint32 index, int64 *size)"),
		GetResultDateModified: lib.func("bool Everything_GetResultDateModified(uint32 index, int64 *dateModified)"),
		GetLastError: lib.func("uint32 Everything_GetLastError()")
	};
	try {
		api.IsDBLoaded = lib.func("bool Everything_IsDBLoaded()");
	} catch {}
	// The version pair is the DLL's own, not Everything.exe's: the probe reports
	// what answered. Optional like IsDBLoaded - a build without them still probes.
	try {
		api.GetMajorVersion = lib.func("uint32 Everything_GetMajorVersion()");
		api.GetMinorVersion = lib.func("uint32 Everything_GetMinorVersion()");
	} catch {}
	return { koffi, api };
}

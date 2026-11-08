/**
 * @module lib/components/anytxt/anytxt.mjs
 *
 * The Anytxt Searcher content backend: a thin JSON-RPC client for the Anytxt
 * GUI (`ATGUI.exe`), ported from dsh-local-search's `lib/anytxt.js` and cut
 * down to this plugin's three-tool surface (`anytxt_search` / `anytxt_read` /
 * `anytxt_status`).
 *
 * Self-contained on purpose: it binds no DLL, imports nothing of this package
 * but `lib/shared/limits.mjs` (the offset cap), and shares no state with
 * `lib/components/everything/sdk.mjs`, `.../query-worker.mjs` or `.../status.mjs`.
 * Taking it on therefore leaves the koffi / worker-thread
 * path (the `rt.workerEntry` / `rt.inFlight` / `rt.chain` fields of one
 * `createQueryRuntime()` instance) untouched, and an Anytxt that
 * is down cannot drag file-name search with it.
 *
 * What the port drops, deliberately:
 * - the multi-root fan-out (one Search per root), the exact-name pinning and
 *   the round-robin merge: `dir` is one required directory now, and the merge
 *   had no notion of `offset`, so it could repeat or skip items across pages;
 * - `QUERY_SYNTAX` / `nameParts` / `isExactName`, whose only caller was that
 *   pinning;
 * - `EngineError`: failures are {@link AnyTxtError}, carrying a stable `code`
 *   from {@link ANYTXT_ERROR_CODES}.
 *
 * Kept as the source plugin measured them: loopback-only endpoints, 9921 tried
 * only on the default port, `redirect: "error"` on every request, the
 * timeout/abort merge, and `result.data.output` as the only accepted reply.
 */
import { existsSync } from "node:fs";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { clampOffset } from "../../shared/limits.mjs";

//#region constants
/**
 * The path ATGUI serves its JSON-RPC API on. Its root is the help page, so a
 * POST there answers 404 even while the GUI is running (measured on 0.4.x:
 * `POST /` -> 404, `POST /rpc` -> {"errno":0,...}).
 */
export const ANYTXT_RPC_PATH = "/rpc";
/** Default Anytxt JSON-RPC endpoint: the GUI serves it on loopback under /rpc. */
export const DEFAULT_ANYTXT_URL = `http://127.0.0.1:9920${ANYTXT_RPC_PATH}`;
/** The default port, and the one some Anytxt builds answer on instead. */
export const DEFAULT_ANYTXT_PORT = new URL(DEFAULT_ANYTXT_URL).port;
export const FALLBACK_ANYTXT_PORT = "9921";
/** One request's budget in milliseconds (the `anytxtTimeoutMs` config). */
export const ANYTXT_RPC_TIMEOUT_MS = 15000;
/** Default and hard ceiling on one page of `anytxt_search` results. */
export const ANYTXT_DEFAULT_LIMIT = 20;
/**
 * Hard ceiling on one page of hits. Measured on this build's API v1: `limit` is
 * an integer in [1, 300] and an omitted value means 300, so 500 would be
 * rejected outright (`-32602 'limit' is outside its valid integer range`).
 */
export const ANYTXT_MAX_LIMIT = 300;
/**
 * Default and hard ceiling on the fragments one `anytxt_read` returns. The ceiling
 * is 8, not 32: `GetFragmentAll` ignores `limit` entirely (measured - 3, 8, 32 and
 * 300 all come back with exactly 8 passages and an echoed `limit: 8`), so a
 * documented 32 promised a page this server never sends. Client-side slicing can
 * still go below 8; it can never go above it.
 */
export const ANYTXT_DEFAULT_FRAGMENTS = 8;
export const ANYTXT_MAX_FRAGMENTS = 8;
/** Default and hard ceiling on the characters one `anytxt_read` full call returns. */
export const ANYTXT_DEFAULT_CHARS = 8000;
export const ANYTXT_MAX_CHARS = 40000;
/**
 * Hard ceiling on one Anytxt offset: `GetResult` takes a signed 32-bit integer.
 * Measured on the live endpoint - `offset: 2147483647` answers an empty page,
 * while `2147483648` and `4294967295` answer `-32602 'offset' is outside its
 * valid integer range`. That rejection is mapped to ANYTXT_RPC, so clamping into
 * Everything's uint32 window would turn a bad argument into a fake backend
 * failure for the whole upper half of the range. Hence its own number here, not
 * an alias of `OFFSET_CAP`.
 *
 * The same cap bounds `anytxt_read`'s character offset as well: an extracted text
 * is nowhere near 2^31 characters, so one boundary serves both.
 */
export const ANYTXT_OFFSET_CAP = 2147483647;
/**
 * The `order` values the Anytxt API accepts, and what each one sorts by. All
 * five were measured on the live endpoint: 0 default, 1 dateModified
 * ascending, 2 dateModified descending, 3 path ascending, 4 path descending,
 * and the five returned different files for the same query. A value outside
 * this table is an argument error rather than a silent 0 - the API answers
 * something for anything in range, so a typo would otherwise read as "sorted".
 */
export const ANYTXT_ORDER_VALUES = new Map([
	[0, "default"],
	[1, "dateModified ascending"],
	[2, "dateModified descending"],
	[3, "path ascending"],
	[4, "path descending"]
]);
/**
 * One `anytxt_sync_index` call's budget. Building an index is far slower than a
 * query - a small folder finished within 6 s measured, a large one is unknown -
 * so it gets its own ceiling instead of borrowing the 15 s query budget.
 */
export const DEFAULT_ANYTXT_SYNC_TIMEOUT_MS = 60000;
/**
 * Path fragments dropped from every content result by default. A default, not a
 * law: `exclude` overrides the list and `exclude: ""` turns it off, and the count
 * in force is written into the result header, so a dropped row is never silent.
 * The index covers the whole disk, so a broad `pattern` would otherwise spend its
 * page on the recycle bin and the system restore store.
 */
export const DEFAULT_EXCLUDE_FRAGMENTS = ["$RECYCLE.BIN", "System Volume Information", "WinSxS"];

/**
 * The matcher for one resolved rule list: case-insensitive substring, the same
 * shape `everything_search` renders as `!path:<fragment>`. An empty list matches
 * nothing, which is what `exclude: ""` means.
 */
function exclusionMatcher(rules) {
	if (!Array.isArray(rules) || rules.length === 0) return () => false;
	const lowered = rules.map((rule) => String(rule).trim().toLowerCase()).filter((rule) => rule.length > 0);
	return (file) => {
		const path = String(file).toLowerCase();
		return lowered.some((rule) => path.includes(rule));
	};
}

/** `exclude` as a rule list: `undefined` keeps the defaults, `""` disables them. */
export function parseAnytxtExclude(value) {
	if (value === void 0) return DEFAULT_EXCLUDE_FRAGMENTS.slice();
	return String(value).split(";").map((rule) => rule.trim()).filter((rule) => rule.length > 0);
}
// 旧的硬编码正则表已由 `DEFAULT_EXCLUDE_FRAGMENTS` + `exclusionMatcher` 取代：规则要能
// 被 `exclude` 覆盖或关掉，也要能回报生效条数，一张常量表做不到这两件事。
/**
 * A `ref` names the engine it came from (`anytxt:<fid>`), so `anytxt_read` can
 * refuse an id another engine handed out instead of asking Anytxt about it.
 */
const REF_PREFIX = "anytxt:";
//#endregion

//#region errors
/**
 * Every code this backend reports, with a one-line hint. Kept apart from
 * `EVERYTHING_ERROR_CODES` in `lib/sdk.mjs`: the two engines fail for different
 * reasons, and one shared table would put Anytxt failures behind Everything
 * names. `ANYTXT_READY`, `ANYTXT_INDEX_NOT_LOADED` and `ANYTXT_MISSING_TOOL`
 * are `anytxt_status` verdicts, not search failures.
 */
export const ANYTXT_ERROR_CODES = new Map([
	["ANYTXT_READY", { hint: "the Anytxt index answered, so anytxt_search can search this machine's files" }],
	// 保留这个码，但 `anytxt_status` 不再产出它：一次探针的 0 命中无法区分「索引为空」与
	// 「索引里没有这个词」，据此判 ok:false 会把可用索引报成不可用。索引是否为空由真正的
	// 搜索来回答（空结果 + indexed copy may be stale）。
	["ANYTXT_INDEX_NOT_LOADED", { hint: "reserved: no longer a probe verdict, because one probe's zero matches cannot tell an empty index from an index without that word" }],
	["ANYTXT_MISSING_TOOL", { hint: "no ATGUI.exe was found and the endpoint does not answer: Anytxt looks absent" }],
	["ANYTXT_DOWN", { hint: "the Anytxt JSON-RPC endpoint is unreachable" }],
	["ANYTXT_TIMEOUT", { hint: "the Anytxt request did not answer within its budget" }],
	["ANYTXT_ABORTED", { hint: "the Anytxt request was cancelled (tool timeout or caller cancellation)" }],
	["ANYTXT_HTTP", { hint: "the Anytxt endpoint answered with a non-2xx HTTP status" }],
	["ANYTXT_RPC", { hint: "Anytxt rejected the JSON-RPC call, or answered without result.data.output" }],
	["ANYTXT_BAD_OUTPUT", { hint: "Anytxt answered with something that is not the expected JSON object" }],
	["ANYTXT_ENDPOINT_REMOTE", { hint: "the configured Anytxt endpoint is not a loopback address" }],
	["ANYTXT_FID_NOT_FOUND", { hint: "the index has no document for that fid, so there is no text to read; take the ref from a fresh anytxt_search" }],
	["ANYTXT_INVALID_ARGUMENT", { hint: "an argument of the anytxt tool was rejected before any request was sent" }]
]);

/** The hint of one code, so a thrown error and the status text say the same thing. */
function hintFor(code) {
	return ANYTXT_ERROR_CODES.get(code)?.hint;
}

/** One failure: a stable `code` plus the hint the tool surfaces. */
export class AnyTxtError extends HarnessError {
	code;
	constructor(message, code, options) {
		super(message, code, options);
		this.code = code;
	}
}

/**
 * The one argument rejection all three tools share: a bad `mode`, a missing
 * `query`, a `dir` that is not a directory. It lives here so `lib/index.js`
 * never spells an ANYTXT_* code literal itself - the README code table is
 * checked against the literals in `lib/`, and a second spelling would be a
 * second thing to keep in step.
 */
export function invalidArgument(message, hint) {
	return new AnyTxtError(message, "ANYTXT_INVALID_ARGUMENT", hint === void 0 ? void 0 : { hint });
}
//#endregion

//#region endpoint
/**
 * Whether one address is this machine. The rule lives here, at the one place
 * that resolves endpoints, so a profile still pointing at another machine can
 * only fail content search - never silently describe a remote index as local.
 */
function isLoopbackUrl(value) {
	let parsed;
	try {
		parsed = new URL(String(value));
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	const host = parsed.hostname.toLowerCase();
	// `URL.hostname` 对 IPv6 给的是带方括号的 `[::1]`，所以裸 `::1` 那一支永远不成立（死代码）。
	// 回环按整段 127.0.0.0/8 认，不再只认 .1：127.0.0.2 也是本机，误拒一个本机端点比放行
	// 一个非本机端点更容易踩到（这里只收紧，不放宽到任意 IPv6）。
	if (host === "localhost" || host === "[::1]" || host === "[0:0:0:0:0:0:0:1]" || host === "[::ffff:127.0.0.1]") return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	return v4 !== null && Number(v4[1]) === 127 && [v4[2], v4[3], v4[4]].every((part) => Number(part) <= 255);
}

/**
 * The main address, plus the 9921 fallback some Anytxt builds use. The fallback
 * is only tried when the configured address already uses the default port: a
 * port the user picked is not ours to swap.
 *
 * @throws {AnyTxtError} ANYTXT_ENDPOINT_REMOTE when the address is not loopback.
 */
export function resolveAnytxtUrls(url = DEFAULT_ANYTXT_URL) {
	const raw = String(url || DEFAULT_ANYTXT_URL).replace(/\/+$/, "");
	if (!isLoopbackUrl(raw)) {
		throw new AnyTxtError(`Anytxt endpoint must be local, not ${raw}`, "ANYTXT_ENDPOINT_REMOTE", { hint: hintFor("ANYTXT_ENDPOINT_REMOTE") });
	}
	// 只给 origin 的老配置自动补上 /rpc：ATGUI 的根路径是帮助网页，POST 过去必 404。
	// 已带路径的配置原样使用；回退口只换端口，不换路径。
	const parsed = new URL(raw);
	const base = parsed.pathname === "" || parsed.pathname === "/" ? `${raw}${ANYTXT_RPC_PATH}` : raw;
	const urls = [base];
	if (new URL(base).port === DEFAULT_ANYTXT_PORT) {
		const fallback = new URL(base);
		fallback.port = FALLBACK_ANYTXT_PORT;
		urls.push(fallback.toString().replace(/\/$/, ""));
	}
	return urls;
}
//#endregion

//#region host evidence
/** The directory a probe asks about: this platform's first drive root. */
export function defaultProbeRoot() {
	const drive = typeof process.env.SystemDrive === "string" && process.env.SystemDrive.length > 0 ? process.env.SystemDrive : "C:";
	const trimmed = drive.replace(/[\\/]+$/, "");
	return `${trimmed}\\`;
}

/** ATGUI.exe's usual install locations, most likely first. */
export function anytxtCandidates() {
	const programFiles = process.env.ProgramFiles || "C:\\Program Files";
	const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
	const localAppData = process.env.LOCALAPPDATA || "";
	return [
		`${programFiles}\\Anytxt Searcher\\ATGUI.exe`,
		`${programFilesX86}\\Anytxt Searcher\\ATGUI.exe`,
		localAppData ? `${localAppData}\\Programs\\Anytxt Searcher\\ATGUI.exe` : ""
	].filter(Boolean);
}

/**
 * Whether Anytxt is probably installed. Finding ATGUI.exe is evidence; not
 * finding it is *not* evidence of absence (portable and custom installs sit
 * elsewhere), so the answer is `null` (unknown), never `false`.
 */
export function anytxtInstalled() {
	return anytxtCandidates().some((candidate) => existsSync(candidate)) ? true : null;
}
//#endregion

//#region query shape
/**
 * `pattern` as the server wants it: trimmed, and nothing else.
 *
 * This build ignores `st` completely (measured: it never appears in the echoed
 * input, while every parameter that does take effect does), so the exact-phrase
 * semantics come only from the double quotes inside `pattern`. `st` is still sent
 * because it is harmless - but the old "strip the quotes, then set st=1" deleted
 * the one signal that worked, which is why a quoted phrase matched exactly the
 * same set as the bare words (15 vs 69 measured on the live endpoint).
 */
export function quoteAware(query) {
	const trimmed = String(query ?? "").trim();
	if (/^".*"$/s.test(trimmed)) return { pattern: trimmed, st: "1" };
	return { pattern: trimmed, st: "2" };
}

/** Drop the hit markers Anytxt wraps around the matched terms of a fragment. */
export function stripHighlights(text) {
	return String(text ?? "").replace(/\*<<\*|\*>>\*/g, "");
}

/** `123` -> `anytxt:123`. */
export function formatRef(id) {
	return `${REF_PREFIX}${id}`;
}

/**
 * `anytxt:123` -> `{ engine: "anytxt", id: "123" }`; a foreign or malformed ref is
 * an argument error. The engine is parsed out and asserted instead of assumed:
 * a ref that names another engine is the one mistake a bare prefix check let
 * through, and it then reached Anytxt as a fid nobody indexed.
 *
 * The engine is read before the prefix check on purpose: `everything:7` does not
 * start with `anytxt:`, so a prefix check first would answer "missing prefix"
 * and never name the engine the caller actually passed.
 */
export function parseRef(ref) {
	if (typeof ref !== "string" || ref.trim().length === 0) throw new AnyTxtError("ref must be a non-empty string", "ANYTXT_INVALID_ARGUMENT");
	const value = ref.trim();
	const separator = value.indexOf(":");
	const engine = separator > 0 ? value.slice(0, separator) : "";
	// Keeps both `anytxt:` and the engine name in one message: callers are told
	// what to pass, and which engine the ref really belongs to.
	if (engine.length > 0 && `${engine}:` !== REF_PREFIX) throw new AnyTxtError(`ref must start with ${REF_PREFIX} (this ref belongs to ${engine})`, "ANYTXT_INVALID_ARGUMENT");
	if (!value.startsWith(REF_PREFIX)) throw new AnyTxtError(`ref must start with ${REF_PREFIX} (an anytxt ref comes from anytxt_search)`, "ANYTXT_INVALID_ARGUMENT");
	const id = value.slice(REF_PREFIX.length);
	if (id.length === 0) throw new AnyTxtError("ref must carry an id after the anytxt: prefix", "ANYTXT_INVALID_ARGUMENT");
	// fid 是十进制数字串（19-20 位，保持字符串以免丢精度）。不校验就会把 `anytxt:abc`
	// 发到服务端，再被映射成 ANYTXT_RPC —— 一个参数错误被报成后端故障，方向刚好相反。
	if (!/^\d+$/.test(id)) throw new AnyTxtError(`ref id must be the digits anytxt_search printed, not ${JSON.stringify(id)}`, "ANYTXT_INVALID_ARGUMENT");
	return { engine: REF_PREFIX.slice(0, -1), id };
}

/**
 * One result tuple `[fid, lastModify(seconds), size, file]` as a result item, or
 * `undefined` when it is unusable or sits in an excluded directory.
 */
function parseFileTuple(tuple, isExcluded = () => false) {
	if (!Array.isArray(tuple) || tuple.length < 4) return void 0;
	const [fid, lastModify, size, file] = tuple;
	if (typeof file !== "string" || isExcluded(file)) return void 0;
	const numericSize = Number(size);
	const numericModified = Number(lastModify);
	const item = {
		ref: formatRef(String(fid)),
		path: file
	};
	// 读不到、或超过 2^53 的 size 一律省掉整键：留一个 undefined 键，宿主判无损 JSON
	// 时严格往返就不相等（0.4.9 那条教训）。
	if (Number.isSafeInteger(numericSize) && numericSize >= 0) item.size = numericSize;
	// 只判有限不够：`new Date(1e20).toISOString()` 抛 RangeError，会把整页结果打掉。
	// 日期可表示的区间是 ±8.64e15 ms，越界与读不到一样省键。
	const modifiedMs = numericModified * 1000;
	if (Number.isFinite(modifiedMs) && modifiedMs > 0 && modifiedMs <= 8640000000000000) item.modified = new Date(modifiedMs).toISOString();
	return item;
}

/**
 * Whether one numeric argument is absent rather than zero. `Number(null)`, `""`
 * and `Number(true)` all coerce to 0/1, which would silently turn a missing value
 * into page size 1 instead of the documented default. Booleans and the two empty
 * shapes are therefore treated as missing, before any coercion.
 */
function isAbsentNumber(value) {
	return value === void 0 || value === null || value === "" || typeof value === "boolean";
}

/** `limit` clamped into [1, ANYTXT_MAX_LIMIT]; a missing or unusable value is the default. */
export function clampAnytxtLimit(value, fallback = ANYTXT_DEFAULT_LIMIT) {
	if (isAbsentNumber(value)) return fallback;
	const requested = Number(value);
	if (!Number.isFinite(requested)) return fallback;
	return Math.min(ANYTXT_MAX_LIMIT, Math.max(1, Math.floor(requested)));
}

/**
 * `offset` clamped into [0, ANYTXT_OFFSET_CAP]; non-finite input is the first
 * page. An alias, not a copy: the one implementation is `clampOffset` in
 * `lib/shared/limits.mjs`, handed this side's cap.
 */
export const clampAnytxtOffset = (value) => clampOffset(value, ANYTXT_OFFSET_CAP);

/**
 * `max` for fragments clamped into [1, ANYTXT_MAX_FRAGMENTS]; a missing or unusable
 * value is the default. Its own function because the page ceiling (300) and the
 * fragment ceiling (8) are different numbers - borrowing one clamp for the other
 * meant a comparison that was always true and never clamped anything.
 */
export function clampAnytxtFragments(value) {
	if (isAbsentNumber(value)) return ANYTXT_DEFAULT_FRAGMENTS;
	const requested = Number(value);
	if (!Number.isFinite(requested)) return ANYTXT_DEFAULT_FRAGMENTS;
	return Math.min(ANYTXT_MAX_FRAGMENTS, Math.max(1, Math.floor(requested)));
}

/**
 * `order` as one of 0-4; a missing value is 0, anything else is an argument
 * error. The whitelist lives here, not in the tool schema, because this host's
 * value-schema DSL takes no `enum` - the same reason `everything_search`
 * validates `sort` and `type` in `execute`.
 */
export function parseAnytxtOrder(value) {
	if (value === void 0 || value === null) return 0;
	const requested = Number(value);
	if (!Number.isInteger(requested) || !ANYTXT_ORDER_VALUES.has(requested)) {
		throw invalidArgument(`order must be one of ${[...ANYTXT_ORDER_VALUES.keys()].join(", ")} (0 default, 1 dateModified ascending, 2 dateModified descending, 3 path ascending, 4 path descending); got ${String(value)}`);
	}
	return requested;
}

/**
 * One Windows directory path in the shape both Anytxt call sites send:
 * backslashes, no trailing separator, and a drive root kept as `C:\`. Pure on
 * purpose - the shape is the only thing the two callers share. Existence and
 * absolute-path checks do NOT belong here: building an index needs an existing
 * absolute folder, filtering a query does not.
 */
export function normalizeWindowsDir(dir) {
	const win = String(dir ?? "").trim().replace(/\//g, "\\");
	// 盘根是 `C:\`：连分隔符一起剥掉会得到 `C:`，那不是目录路径。
	if (/^[A-Za-z]:\\+$/.test(win)) return `${win[0]}:\\`;
	return win.replace(/\\+$/, "");
}

/**
 * The folder an index is built for, as the API wants it.
 *
 * Two shapes are rejected here because the API rejects neither (both measured):
 * a folder that does not exist answers `errno 0`, and a path with no drive
 * letter names nothing at all. Neither is a silent "accepted".
 *
 * A forward-slash path is NOT rejected: it is the measured form that also
 * answers `errno 0` and builds nothing, which is exactly why
 * {@link normalizeWindowsDir} rewrites it to backslashes first - the index is
 * then built for the folder the caller meant instead of failing quietly.
 */
export function normalizeSyncFolder(folder, { exists = existsSync } = {}) {
	if (typeof folder !== "string" || folder.trim().length === 0) throw invalidArgument("folder must be a non-empty absolute Windows directory: an index is built for one folder per call, so a blank value names nothing.", "a sync call needs the folder it should index.");
	const win = normalizeWindowsDir(folder);
	const absolute = /^[A-Za-z]:\\/.test(win) || win.startsWith("\\\\");
	if (!absolute) throw invalidArgument(`folder must be an absolute Windows path, not ${win}: pass the folder's own path, e.g. C:\\Users\\you\\Documents.`, "a relative path resolves against this process, not against the user's intent.");
	if (!exists(win)) throw invalidArgument(`folder does not exist: ${win}; index an existing directory, because the API answers errno 0 for a missing one and builds nothing.`, "the API does not check the folder for us.");
	return win;
}
//#endregion

//#region rpc
/** Send one JSON-RPC POST and return `result.data.output`. */
export async function anytxtRpc(url, method, input, { timeoutMs = ANYTXT_RPC_TIMEOUT_MS, signal, fetchImpl = fetch, directParams = false, withErrno = false } = {}) {
	// 计时器构造本身也可能抛（只收整数、0..4294967295），所以放进 try 里：坏预算要变成一条
	// 带 code 的参数错误，而不是一条没有 ANYTXT_* 前缀的裸 RangeError。
	let combined;
	try {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	} catch (error) {
		throw new AnyTxtError(`Anytxt request budget ${String(timeoutMs)} is unusable: it must be an integer in 0..4294967295`, "ANYTXT_INVALID_ARGUMENT", { cause: error, hint: hintFor("ANYTXT_INVALID_ARGUMENT") });
	}
	let response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			// v1 methods take their parameters directly in `params`; the older
			// ATRpcServer methods wrapped them in `input`. One transport, two shapes -
			// a second copy of the error mapping would drift from this one.
			body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: directParams ? input : { input } }),
			signal: combined,
			// 307/308 会把这个 body 重新 POST 到地址指向的任何地方，于是一个本机服务就能把请求
			// 弹到别的机器上，而它的回答还会被当成索引数据信下来。
			redirect: "error"
		});
	} catch (error) {
		if (signal?.aborted) throw new AnyTxtError("Anytxt request was aborted", "ANYTXT_ABORTED", { cause: error });
		if (error?.name === "TimeoutError") throw new AnyTxtError("Anytxt request timed out", "ANYTXT_TIMEOUT", { cause: error, hint: hintFor("ANYTXT_TIMEOUT") });
		throw new AnyTxtError(unreachableMessage(error), "ANYTXT_DOWN", { cause: error, hint: hintFor("ANYTXT_DOWN") });
	}
	if (!response.ok) {
		throw new AnyTxtError(`Anytxt returned HTTP ${response.status}`, "ANYTXT_HTTP", { hint: hintFor("ANYTXT_HTTP") });
	}
	let data;
	try {
		data = await response.json();
	} catch (error) {
		if (signal?.aborted) throw new AnyTxtError("Anytxt request was aborted", "ANYTXT_ABORTED", { cause: error });
		if (error?.name === "TimeoutError") throw new AnyTxtError("Anytxt response timed out", "ANYTXT_TIMEOUT", { cause: error });
		throw new AnyTxtError("Anytxt returned non-JSON", "ANYTXT_BAD_OUTPUT", { cause: error, hint: hintFor("ANYTXT_BAD_OUTPUT") });
	}
	if (!data || typeof data !== "object") {
		throw new AnyTxtError("Anytxt returned a non-object JSON value", "ANYTXT_BAD_OUTPUT", { hint: hintFor("ANYTXT_BAD_OUTPUT") });
	}
	if (data.error) {
		throw new AnyTxtError(`Anytxt RPC error: ${JSON.stringify(data.error)}`, "ANYTXT_RPC", { hint: hintFor("ANYTXT_RPC") });
	}
	// syncIndex 要看 errno（0 之外是拒绝），其余方法只认 output：两种取值在同一处
	// 传输里分支，不另开一套 fetch 与错误映射。
	if (withErrno) return { errno: data.result?.errno, output: data.result?.data?.output ?? {} };
	const output = data.result?.data?.output;
	if (output === undefined) throw new AnyTxtError("Anytxt returned no result.data.output", "ANYTXT_RPC", { hint: hintFor("ANYTXT_RPC") });
	return output;
}

/** Try the main address, and the 9921 fallback only when nothing answered at all. */
async function rpcFirst(urls, method, input, options) {
	let lastError;
	for (const url of urls) {
		try {
			return await anytxtRpc(url, method, input, options);
		} catch (error) {
			lastError = error;
			if (error.code === "ANYTXT_DOWN" && url !== urls[urls.length - 1]) continue;
			throw error;
		}
	}
	// 循环要么 return 要么 throw：`urls` 至少一项，走到这里不可达，所以没有兜底 throw。
}
//#endregion

//#region search
/**
 * One page of content hits for `pattern` under the single directory `dir`.
 *
 * `count` comes from Search, so `total` is the whole set; `offset` goes straight
 * to GetResult. The source plugin always asked for offset 0 and then re-ordered
 * the page locally, which cannot page at all. Whether GetResult honours `offset`
 * is unverified on the Anytxt side (plan risk 2): if it ignores it, a second page
 * repeats the first while `total` stays the honest count.
 */
export async function searchContent({
	pattern,
	dir,
	ext,
	limit = ANYTXT_DEFAULT_LIMIT,
	offset = 0,
	order = 0,
	exclude,
	url = DEFAULT_ANYTXT_URL,
	timeoutMs = ANYTXT_RPC_TIMEOUT_MS,
	signal,
	fetchImpl = fetch
} = {}) {
	if (typeof pattern !== "string" || pattern.trim().length === 0) throw new AnyTxtError("pattern must be a non-empty string", "ANYTXT_INVALID_ARGUMENT");
	// dir 必填：filterDir 传空串是否等同整盘从未实测，而多根轮转这次已删，没有兜底根。
	if (typeof dir !== "string" || dir.trim().length === 0) throw new AnyTxtError("dir must be a non-empty directory path (a content search needs one indexed folder)", "ANYTXT_INVALID_ARGUMENT");
	const urls = resolveAnytxtUrls(url);
	const { pattern: queryPattern, st } = quoteAware(pattern);
	const wanted = clampAnytxtLimit(limit);
	const start = clampAnytxtOffset(offset);
	const sortOrder = parseAnytxtOrder(order);
	const filter = {
		pattern: queryPattern,
		// 只归一形状、不查存在性：`dir` 只是过滤条件，未建索引的目录必须回空而不是报
		// 参数错误。实测正斜杠写法回 0 命中且不报错，会被读成「索引里没有」，所以分隔符
		// 在这里统一（`normalizeSyncFolder` 那套「绝对路径 + 目录必须存在」不许搬过来）。
		filterDir: normalizeWindowsDir(dir),
		filterExt: ext || "*",
		lastModifyBegin: 0,
		lastModifyEnd: 2147483647,
		st
	};
	// 排除规则是可读的值，不是内部常量表：条数要回报、`exclude: ""` 要能关掉。
	const rules = parseAnytxtExclude(exclude);
	const isExcluded = exclusionMatcher(rules);
	const options = { timeoutMs, signal, fetchImpl };
	const countOut = await rpcFirst(urls, "ATRpcServer.Searcher.V1.Search", filter, options);
	const total = typeof countOut?.count === "number" && Number.isFinite(countOut.count) ? countOut.count : 0;
	const items = [];
	// 服务器按"原始行号"分页（实测 offset 1:1 滑动），所以翻页必须用原始返回行数前进，
	// 而不是过滤后的条数：被排除的行落在页内任意位置时，用过滤后条数会让下一页重新
	// 覆盖原始页尾，把没被排除的行重复发出来。
	let rawCount = 0;
	if (total > start) {
		// order 透传给 GetResult：0 默认 / 1 修改时间升 / 2 修改时间降 / 3 路径升 /
		// 4 路径降，五个取值在真机各回不同文件。缺省仍是 0，行为与加参数之前一致。
		const page = await rpcFirst(urls, "ATRpcServer.Searcher.V1.GetResult", { ...filter, limit: wanted, offset: start, order: sortOrder }, options);
		const rows = Array.isArray(page?.files) ? page.files : [];
		rawCount = rows.length;
		for (const tuple of rows) {
			const item = parseFileTuple(tuple, isExcluded);
			if (item !== void 0) items.push(item);
		}
	}
	const truncated = total > start + rawCount;
	const value = { items, total, truncated, offset: start, excluded: rules.length };
	// 用原始行数前进：整页被过滤光时 offset 也照走，不会原地打转，所以旧的那层
	// 「items 为空就不写 nextOffset」保护不再需要。只有服务器真回了 0 行才不写，
	// 那时 truncated 为真却没有前进量，写了才会死循环。
	if (truncated && rawCount > 0) value.nextOffset = start + rawCount;
	return value;
}
//#endregion

//#region sync
/**
 * Build (or refresh) the index for one folder.
 *
 * This is the only call in this module that changes index state, and the API is
 * quiet about the ways it goes wrong: a forward-slash path answers `errno 0` and
 * indexes nothing, and so does a folder that does not exist (both measured on
 * the live endpoint). The path is therefore normalized here, the folder is
 * checked here, and `errno` is read here - none of the three is left to the
 * server. What comes back is "the request was accepted", not "the index is
 * ready": building runs in the background, so the caller confirms with a
 * search.
 */
export async function syncIndex({
	folder,
	url = DEFAULT_ANYTXT_URL,
	timeoutMs = DEFAULT_ANYTXT_SYNC_TIMEOUT_MS,
	signal,
	fetchImpl = fetch,
	exists = existsSync
} = {}) {
	const target = normalizeSyncFolder(folder, { exists });
	const result = await rpcFirst(
		resolveAnytxtUrls(url),
		"anytxt.v1.syncIndex",
		{ folder: target },
		{ timeoutMs, signal, fetchImpl, directParams: true, withErrno: true }
	);
	if (result.errno !== 0) throw new AnyTxtError(`Anytxt refused to index ${target} (errno ${String(result.errno)})`, "ANYTXT_RPC", { hint: hintFor("ANYTXT_RPC") });
	return {
		folder: target,
		ok: true,
		// 不用 ANYTXT_READY：那个码在本文件里明确定义为 `anytxt_status` 的判决，借它来报
		// 「请求已接受」会让一次写路径的结果读起来像一次探活判决。
		code: "ANYTXT_SYNC_ACCEPTED",
		message: `Anytxt accepted ${target}; the index is built in the background, so anytxt_search usually answers within seconds.`
	};
}
//#endregion

//#region read
/** The fragments around the hits of `query` inside one indexed file. */
export async function getFragments({
	ref,
	query,
	max = ANYTXT_DEFAULT_FRAGMENTS,
	url = DEFAULT_ANYTXT_URL,
	timeoutMs = ANYTXT_RPC_TIMEOUT_MS,
	signal,
	fetchImpl = fetch
} = {}) {
	const { id } = parseRef(ref);
	if (typeof query !== "string" || query.trim().length === 0) throw new AnyTxtError("query must be a non-empty string (fragments need the terms that hit)", "ANYTXT_INVALID_ARGUMENT");
	const wanted = clampAnytxtFragments(max);
	const output = await rpcFirst(resolveAnytxtUrls(url), "ATRpcServer.Searcher.V1.GetFragmentAll", { fid: id, pattern: query }, { timeoutMs, signal, fetchImpl });
	const all = (Array.isArray(output?.text) ? output.text : []).map(stripHighlights).filter((snippet) => snippet.length > 0);
	const snippets = all.slice(0, wanted);
	return { snippets, totalSnippets: all.length };
}

/** The extracted text of one indexed file, sliced by `offset` / `maxChars`. */
export async function getRawText({
	ref,
	offset = 0,
	maxChars = ANYTXT_DEFAULT_CHARS,
	url = DEFAULT_ANYTXT_URL,
	timeoutMs = ANYTXT_RPC_TIMEOUT_MS,
	signal,
	fetchImpl = fetch
} = {}) {
	const { id } = parseRef(ref);
	const start = clampAnytxtOffset(offset);
	const requestedChars = Number(maxChars);
	const wanted = Number.isFinite(requestedChars) ? Math.min(ANYTXT_MAX_CHARS, Math.max(1, Math.floor(requestedChars))) : ANYTXT_DEFAULT_CHARS;
	// `withErrno` 是这条读路径的关键：实测 fid 不存在时服务端回 `errno 1` + `text: null`，
	// 有效 fid 回 `errno 0` + 字符串（`GetFragmentAll` 则两种都回 0，所以分不出）。不读 errno
	// 就只能把「这个 id 没有文档」渲染成 `0 of 0 characters` 的成功——调用方会以为读到一个
	// 空文档，而不是一个不存在的引用。errno 缺失时不擅自判死，免得一个不带该字段的版本全红。
	const reply = await rpcFirst(resolveAnytxtUrls(url), "ATRpcServer.Searcher.V1.GetRawTextByFID", { fid: id }, { timeoutMs, signal, fetchImpl, withErrno: true });
	if (typeof reply.errno === "number" && reply.errno !== 0) throw new AnyTxtError(`Anytxt has no document for ${ref} (errno ${String(reply.errno)}): the index holds no fid with that id, so there is no text to read`, "ANYTXT_FID_NOT_FOUND", { hint: hintFor("ANYTXT_FID_NOT_FOUND") });
	// withErrno 会把缺失的 output 折成 `{}`，所以这里自己把「回了但没有 output」判回 ANYTXT_RPC，
	// 与不带 errno 的老路径同一条错误语义。
	if (!Object.hasOwn(reply.output ?? {}, "text")) throw new AnyTxtError("Anytxt returned no result.data.output", "ANYTXT_RPC", { hint: hintFor("ANYTXT_RPC") });
	const full = typeof reply.output.text === "string" ? reply.output.text : "";
	const text = full.slice(start, start + wanted);
	return { text, totalChars: full.length, returned: text.length, offset: start, truncated: start + text.length < full.length };
}
//#endregion

//#region status
/** `fetch` only says "fetch failed"; the real cause is in `cause`. */
function causeCode(error) {
	const cause = error?.cause;
	if (typeof cause?.code === "string") return cause.code;
	if (Array.isArray(cause?.errors)) {
		const first = cause.errors.find((entry) => typeof entry?.code === "string");
		if (first !== undefined) return first.code;
	}
	return "";
}

/**
 * The "cannot reach it" sentence, carrying the TCP/DNS cause code
 * (`ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT`) so a pasted diagnosis is not one
 * indistinguishable unreachable.
 */
function unreachableMessage(error) {
	const code = causeCode(error);
	if (code !== "") return `Anytxt JSON-RPC is unreachable (${code})`;
	// `redirect: "error"` 拦下的重定向没有 socket code，但 cause 里的句子能认出来：把它
	// 报成「连不上」会让人去查端口，而真相是地址有应答、只是它想把请求弹到别处。
	const causeText = `${error?.cause?.message ?? ""} ${error?.message ?? ""}`;
	if (/redirect/i.test(causeText)) return "Anytxt answered with a redirect, which is refused: a local endpoint must not bounce this request to another host, so the answer was not accepted";
	return "Anytxt JSON-RPC is unreachable";
}

/**
 * Probe Anytxt once; never throws. Three verdicts, which the tool maps onto
 * `ok` / `code` / `message`:
 *
 * - `ready`        - Search answered at all. An answer is the evidence that
 *                    content search works; how many rows the probe word matched
 *                    is an annotation, never a verdict (see below);
 * - `missing-tool` - nothing answered and no ATGUI.exe was found;
 * - `down`         - nothing answered while Anytxt looks installed, or the
 *                    answer itself failed (HTTP / RPC / timeout / aborted).
 *
 * "Zero matches" used to be a fourth verdict and reported `ok: false`, which
 * made a healthy index look unusable whenever the probe word happened to be
 * absent - an index holding no `.txt`, a non-English corpus, or a profile that
 * indexed only `D:\` all reached `ANYTXT_INDEX_NOT_LOADED`. But "the index has
 * no document with this word" and "the index is empty" are indistinguishable
 * from one probe, and a false `ok: false` talks the caller out of a tool that
 * works. Whether the index is empty is what a real search answers (empty result
 * plus the `indexed copy may be stale` note).
 */
export async function probe({
	url = DEFAULT_ANYTXT_URL,
	dir = defaultProbeRoot(),
	timeoutMs = ANYTXT_RPC_TIMEOUT_MS,
	signal,
	fetchImpl = fetch,
	installed = anytxtInstalled
} = {}) {
	let urls;
	try {
		urls = resolveAnytxtUrls(url);
	} catch (error) {
		// 远端地址在探测里就是「这条路用不了」，不是从 probe 里抛出去把状态打成失败。
		return {
			state: "down",
			ok: false,
			code: error?.code ?? "ANYTXT_ENDPOINT_REMOTE",
			message: error?.message ?? `the Anytxt endpoint ${url} is not a loopback address`,
			url: String(url)
		};
	}
	let lastError;
	for (const candidate of urls) {
		try {
			const output = await anytxtRpc(candidate, "ATRpcServer.Searcher.V1.Search", {
				pattern: "the",
				filterDir: dir,
				filterExt: "txt",
				lastModifyBegin: 0,
				lastModifyEnd: 2147483647
			}, { timeoutMs, signal, fetchImpl });
			const count = typeof output?.count === "number" && Number.isFinite(output.count) ? output.count : 0;
			// 应答本身即证据；命中数是附注。0 命中只说「这次探针没匹配到内容」，不改 ok -
			// 否则索引里没有含探针词的文档（只索引了 D:\、语料非英文、就是没有 .txt）会把一个
			// 可用的内容检索报成不可用，而 ok:false 会直接把调用方劝退。
			const message = count > 0
				? `the Anytxt index answered with ${count} match(es), so anytxt_search can search`
				: "the Anytxt index answered, so anytxt_search can search; the probe word matched nothing, which only means this probe found no passage - not that the index is empty";
			return { state: "ready", ok: true, code: "ANYTXT_READY", message, url: candidate };
		} catch (error) {
			lastError = error;
			// 与 rpcFirst 同一条规则：只有「连不上」才值得换下一个端口。
			if (error.code === "ANYTXT_DOWN" && candidate !== urls[urls.length - 1]) continue;
			break;
		}
	}
	const code = lastError?.code ?? "ANYTXT_DOWN";
	const detail = lastError?.message ?? "the Anytxt JSON-RPC endpoint did not answer";
	if (code === "ANYTXT_DOWN") {
		// 端口没人应答既可能没启动、也可能没装：只有找到 ATGUI.exe 才敢说「装了但没在运行」。
		if (installed() !== true) {
				return { state: "missing-tool", ok: false, code: "ANYTXT_MISSING_TOOL", message: `no ATGUI.exe was found and ${urls.join(", ")} did not answer (${detail})`, url: urls[0] };
		}
		return { state: "down", ok: false, code, message: `Anytxt is installed but ${urls.join(", ")} did not answer: ${detail}`, url: urls[0] };
	}
	return { state: "down", ok: false, code, message: detail, url: urls[0] };
}
//#endregion

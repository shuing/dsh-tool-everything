/**
 * @module lib/status.mjs
 *
 * The `everything_status` probe: can `everything_search` answer right now?
 *
 * One SDK load, one `IsDBLoaded`, one version read - no query, no result
 * decoding. Probing is diagnosis, not retrieval.
 *
 * The model-facing view stays thin on purpose: `ok`, `code`, `message`,
 * `version`, `path`. No `state`, no `detail`, no repair steps. A model holding
 * pwsh, grep and glob that reads "the DLL is missing" goes off to install
 * things, while the correct move is to fall back to grep/glob and say the local
 * index is unavailable. Repair instructions live in the README and in the error
 * a search itself throws, never here.
 *
 * Budget: clamped into [{@link PROBE_MIN_BUDGET_MS},
 * {@link PROBE_MAX_BUDGET_MS}], because a probe that reports a healthy engine as
 * DOWN just because the caller passed a 200 ms timeout is worse than no probe at
 * all. A probe that does not answer in time, or one that was cancelled, says so
 * - neither ever reads as a down engine.
 *
 * `./sdk.mjs` is the only import: the SDK bindings keep their one home, and this
 * module never reaches back into the tool module (no cycle).
 */
import { describeLastError, loadSdk, resolveDllPath } from "./sdk.mjs";

/** Lower bound on the probe budget: probing is diagnosis, never retrieval. */
export const PROBE_MIN_BUDGET_MS = 1500;
/** Upper bound on the probe budget; also what a missing budget means. */
export const PROBE_MAX_BUDGET_MS = 5000;

/** The index is loaded: `everything_search` can answer. */
export const STATUS_READY = "EVERYTHING_READY";
/** Everything answers, but its index is not loaded yet: a search cannot. */
export const STATUS_INDEX_NOT_LOADED = "EVERYTHING_INDEX_NOT_LOADED";
/** The probe itself did not answer in time; says nothing about the index. */
export const STATUS_SKIPPED = "STATUS_SKIPPED";
/** The probe was cancelled; says nothing about the index. */
export const STATUS_ABORTED = "STATUS_ABORTED";

/** One line per verdict: what the caller may conclude, and nothing to go fix. */
const VERDICT_MESSAGES = new Map([
	[STATUS_READY, "the index is loaded, so everything_search can answer"],
	[STATUS_INDEX_NOT_LOADED, "Everything answered but its index is not loaded yet, so everything_search cannot answer"],
	[STATUS_SKIPPED, "the probe did not answer within its budget, which says nothing about the index"],
	[STATUS_ABORTED, "the probe was cancelled before it answered, which says nothing about the index"]
]);

/**
 * Clamp one requested budget into [1500, 5000] ms. `timeoutMs` is a retrieval
 * budget; reusing it verbatim would let a small one report a healthy engine as
 * down. A missing or non-finite value means the upper bound.
 */
export function probeBudget(requested) {
	const value = Number(requested);
	if (!Number.isFinite(value)) return PROBE_MAX_BUDGET_MS;
	return Math.min(PROBE_MAX_BUDGET_MS, Math.max(PROBE_MIN_BUDGET_MS, Math.floor(value)));
}

/**
 * One status value. `version` and `path` are added only when known: an undefined
 * key is dropped by JSON.stringify and breaks a lossless round-trip.
 */
function statusValue(code, extra = {}) {
	return {
		ok: code === STATUS_READY,
		code,
		message: extra.message ?? VERDICT_MESSAGES.get(code) ?? `the probe reported ${code}`,
		...(extra.version === void 0 ? {} : { version: extra.version }),
		...(extra.path === void 0 ? {} : { path: extra.path })
	};
}

/** The DLL's own `major.minor`, or `undefined` when the binding is unavailable. */
function sdkVersion(api) {
	const major = typeof api.GetMajorVersion === "function" ? api.GetMajorVersion() : void 0;
	const minor = typeof api.GetMinorVersion === "function" ? api.GetMinorVersion() : void 0;
	return typeof major === "number" && typeof minor === "number" ? `${major}.${minor}` : void 0;
}

/**
 * The probe itself: load the DLL, read the loaded flag, read the version. No
 * `Set*` call, no `QueryW`, no result decoding - a load failure or a missing
 * binding is reported as data, never thrown.
 */
async function runProbe(caps) {
	const dllPath = resolveDllPath(caps);
	let api;
	try {
		({ api } = await loadSdk({ everythingDllPath: caps.everythingDllPath }));
	} catch (error) {
		const code = typeof error?.code === "string" ? error.code : "EVERYTHING_SDK_LOAD_FAILED";
		return statusValue(code, {
			path: dllPath,
			message: `the Everything SDK did not load (${code}), so nothing could be probed`
		});
	}
	const version = sdkVersion(api);
	if (typeof api.IsDBLoaded !== "function") return statusValue(STATUS_SKIPPED, { path: dllPath, version });
	try {
		return statusValue(api.IsDBLoaded() ? STATUS_READY : STATUS_INDEX_NOT_LOADED, { path: dllPath, version });
	} catch (error) {
		// 一次探活失败不是「引擎 DOWN」：透出 SDK 自己的码，别猜。
		const failure = describeLastError(typeof api.GetLastError === "function" ? api.GetLastError() : 0);
		return statusValue(failure.code, {
			path: dllPath,
			version,
			message: `Everything did not answer the probe (${failure.code}), which is neither a loaded nor an unloaded verdict`
		});
	}
}

/**
 * Probe the index with a bounded wait. Aborted and timed-out probes are reported
 * as such: neither is a down engine, and neither throws.
 */
export async function probeEverything(caps = {}, exec) {
	const budgetMs = probeBudget(caps.probeBudgetMs ?? caps.timeoutMs);
	const signal = exec?.signal;
	if (signal?.aborted === true) return statusValue(STATUS_ABORTED);
	const probe = runProbe(caps);
	probe.catch(() => void 0);
	let timer;
	let onAbort;
	const expired = new Promise((resolve) => {
		timer = setTimeout(() => resolve("expired"), budgetMs);
		timer.unref?.();
	});
	const cancelled = typeof signal?.addEventListener === "function"
		? new Promise((resolve) => {
			onAbort = () => resolve("aborted");
			signal.addEventListener("abort", onAbort, { once: true });
		})
		: void 0;
	try {
		const outcome = await Promise.race([probe, expired, ...(cancelled === void 0 ? [] : [cancelled])]);
		if (outcome === "expired") return statusValue(STATUS_SKIPPED, { message: `the probe did not answer within its ${budgetMs}ms budget, which says nothing about the index` });
		if (outcome === "aborted") return statusValue(STATUS_ABORTED);
		return outcome;
	} catch (error) {
		return statusValue(STATUS_SKIPPED, { message: `the probe failed before answering (${error?.code ?? error?.name ?? "error"}), which says nothing about the index` });
	} finally {
		clearTimeout(timer);
		if (onAbort !== void 0) signal.removeEventListener("abort", onAbort);
	}
}

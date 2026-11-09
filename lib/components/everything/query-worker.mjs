/**
 * @module lib/query-worker.mjs
 *
 * The native query worker. `Everything_QueryW` is a blocking FFI call no timer
 * can interrupt, so it runs here instead of on the tool thread: a slow query
 * costs a worker, not the event loop.
 *
 * **It is hosted as a child process** (`child_process.fork`), not a worker
 * thread. Measured reason: `worker.terminate()` while `Everything_QueryW` is in
 * flight returns in 6-8 ms but the thread only exits once the native call
 * returns - so a call stuck inside the DLL keeps holding the SDK's process-wide
 * query lock for the entire life of the host process, and every later query in
 * that process blocks on it. Reloading the plugin does not clear that (measured:
 * a full bundle unload+reload still timed out); only a process exit does. A
 * child process can be SIGKILLed outright, taking its own DLL instance and that
 * lock with it.
 *
 * The same file also still runs under `worker_threads` - `parentPort` is `null`
 * outside a worker thread, and the offline tests drive it that way.
 *
 * One message in, one reply out; the worker itself is not concurrent - the
 * caller keeps a single in-flight promise, so a second request never overlaps
 * the first.
 */
import { existsSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	EverythingError,
	PATH_BUF_UNITS,
	describeLastError,
	filetimeToEpochMs,
	loadSdk,
	requestFlagsFor,
	sortValueFor
} from "./sdk.mjs";

/**
 * The message port this file talks on, in either hosting mode.
 *
 * `parentPort` is `null` in a forked child, so the `process` IPC channel takes
 * over. Both modes expose the same two operations, and nothing below needs to
 * know which one it got.
 */
const port = parentPort ?? {
	// Same `(event, handler)` shape `parentPort.on` has; the only event either side
	// ever uses is "message".
	on: (event, handler) => process.on(event, handler),
	postMessage: (message) => {
		if (typeof process.send === "function") process.send(message);
	}
};


/** Memoize only a successful SDK load; a failed load clears the memo. */
let sdkPromise;
function resolveSdk(config) {
	sdkPromise ??= Promise.resolve().then(() => loadSdk(config)).catch((error) => {
		sdkPromise = void 0;
		throw error;
	});
	return sdkPromise;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** How long `autoStart` waits for Everything to come up before giving up. */
const AUTOSTART_WAIT_MS = 3e3;
const AUTOSTART_POLL_MS = 250;

/** Everything.exe locations to try, then the bare name off PATH. */
function everythingExeCandidates() {
	const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter((root) => typeof root === "string" && root.length > 0);
	const candidates = roots.map((root) => path.join(root, "Everything", "Everything.exe"));
	candidates.push("Everything.exe");
	return candidates;
}

/**
 * Start Everything once, detached and headless; returns the command tried.
 *
 * Candidates are filtered by existence first: `spawn()` does NOT throw for a
 * missing executable - it emits `'error'` asynchronously, which the empty handler
 * below swallows - so the old loop returned the first candidate every time and an
 * Everything installed anywhere else was never started. The bare
 * `Everything.exe` name resolves through PATH and has nothing to stat, so it is
 * always kept as the last resort.
 */
function startEverything() {
	for (const exe of everythingExeCandidates()) {
		if (exe.includes("\\") && !existsSync(exe)) continue;
		try {
			const child = spawn(exe, ["-startup"], { detached: true, stdio: "ignore", windowsHide: true });
			child.on("error", () => {});
			child.unref();
			return exe;
		} catch {}
	}
	return void 0;
}

/**
 * `autoStart` is off by default: the tool does not start a process for the user.
 * With it on, an unloaded index gets one `Everything.exe -startup`, a bounded
 * wait and one retry; a still-unloaded index keeps reporting the SDK's own
 * error code.
 */
async function ensureIndex(api, request) {
	if (request.autoStart !== true) return { started: false };
	const loaded = () => (typeof api.IsDBLoaded === "function" ? Boolean(api.IsDBLoaded()) : true);
	if (loaded()) return { started: false };
	const exe = startEverything();
	const deadline = Date.now() + AUTOSTART_WAIT_MS;
	while (Date.now() < deadline) {
		await sleep(AUTOSTART_POLL_MS);
		if (loaded()) return { started: true, exe };
	}
	return { started: false, exe };
}

/** Run one query against the SDK and collect `request.maxResults` items from `request.offset`. */
async function runOne(request) {
	const { koffi, api } = await resolveSdk(request);
	const countOnly = request.countOnly === true;
	const maximum = countOnly ? 1 : request.maxResults;
	const index = await ensureIndex(api, request);
	const query = () => {
		api.SetSearchW(request.search);
		api.SetMatchPath(false);
		api.SetMatchCase(false);
		api.SetRegex(false);
		// SetSort goes before SetMax: Everything takes the window at max-set time,
		// and the SDK keeps the sort as process-wide state (see sdk.sortValueFor).
		api.SetSort(sortValueFor(request.sort, request.descending));
		api.SetRequestFlags(requestFlagsFor(countOnly));
		api.SetMax(maximum);
		api.SetOffset(request.offset);
		return api.QueryW(true);
	};
	let ok = query();
	if (!ok && index.started) {
		// One retry after a successful autoStart: the very first query can race the
		// index still loading.
		await sleep(AUTOSTART_POLL_MS);
		ok = query();
	}
	if (!ok) {
		const failure = describeLastError(api.GetLastError());
		return {
			ok: false,
			code: failure.code,
			message: failure.message
		};
	}
	const total = api.GetTotResults();
	const dbLoaded = typeof api.IsDBLoaded === "function" ? Boolean(api.IsDBLoaded()) : true;
	if (countOnly) return {
		ok: true,
		total,
		numResults: 0,
		dbLoaded,
		items: []
	};
	const count = Math.min(api.GetNumResults(), request.maxResults);
	const pathBuf = Buffer.allocUnsafe(PATH_BUF_UNITS * 2);
	const valueBuf = Buffer.allocUnsafe(8);
	const items = [];
	for (let i = 0; i < count; i++) {
		const written = api.GetResultFullPathNameW(i, pathBuf, PATH_BUF_UNITS);
		const units = written >= PATH_BUF_UNITS ? PATH_BUF_UNITS - 1 : written;
		const itemPath = units > 0 ? koffi.decode(pathBuf, "char16_t", units) : "";
		const folder = api.IsFolderResult(i);
		// GetResultSize 的 int64 转过 2^53 就丢精度：不安全当读不到（-1），别把假数塞进 schema。
		// 本机没出现不等于不会出现，这道闸零成本。
		const sizeOk = api.GetResultSize(i, valueBuf);
		const decodedSize = sizeOk ? Number(koffi.decode(valueBuf, "int64")) : -1;
		const size = Number.isSafeInteger(decodedSize) ? decodedSize : -1;
		const dateOk = api.GetResultDateModified(i, valueBuf);
		const mtime = dateOk ? filetimeToEpochMs(koffi, valueBuf) : -1;
		items.push({ path: itemPath, folder, size, mtime });
	}
	return {
		ok: true,
		total,
		numResults: count,
		dbLoaded,
		items
	};
}

// 兜底，不是唯一的互斥点：串行已经由上游 `lib/index.js` 每个实例的 `rt.chain`
// （单 `rt.inFlight` 槽那一行 then 链）保证，调用方一次只发一条。这个标志守的是
// worker 自己这一层——上游链条真坏掉、或以后改成多请求并发时，第二条消息
// 拿到 WORKER_BUSY 而不是两条查询在同一个线程里互相踩 `SetSearchW`/`SetMax`
// 那套进程级状态。别因为「上游已串行」就删掉它。
//
// 标志在 finally 里复位：调用方复用这个线程跑下一次查询，不为每次调用重开
// worker；早先那个只加不减的模块级计数器，让第一次回答之后的每条查询都返回
// WORKER_BUSY。
let busy = false;
port.on("message", async (request) => {
	if (busy) {
		port.postMessage({
			ok: false,
			code: "WORKER_BUSY",
			message: "the query worker handles one request at a time"
		});
		return;
	}
	busy = true;
	try {
		port.postMessage(await runOne(request));
	} catch (error) {
		port.postMessage({
			ok: false,
			code: error instanceof EverythingError ? error.code : (error?.code ?? "EVERYTHING_QUERY_FAILED"),
			message: error?.message ?? String(error)
		});
	} finally {
		busy = false;
	}
});

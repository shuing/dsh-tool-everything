/**
 * @module @deepseek-ai/dsh-tool-everything
 *
 * The model-facing `everything_search` tool: search the whole Windows
 * filesystem through the Everything index (voidtools). Execution loads the
 * official Everything SDK DLL (`Everything64.dll`, shipped in `native/`) with
 * koffi and talks to the already-running Everything instance over its IPC
 * channel — no HTTP server, no es.exe, no configuration changes on the
 * Everything side. The tool owns the schema, argument validation, the request
 * shape, result sampling, and formatting; the native call itself runs in a
 * worker thread (`lib/query-worker.mjs`), so a slow query never blocks the
 * event loop.
 *
 * Everything must be running for a query to succeed. A failed query maps the
 * SDK's own last-error value through {@link EVERYTHING_ERROR_CODES}, so an
 * out-of-memory or invalid-call failure is no longer reported as "not
 * running". The search syntax is Everything's own (wildcards, `path:`, `ext:`,
 * `size:`, `regex:`, `|` alternation, …) — see
 * https://www.voidtools.com/support/everything/searching/
 */import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { EVERYTHING_ERROR_CODES, EverythingError, describeLastError } from "./components/everything/sdk.mjs";
import { probeEverything } from "./components/everything/status.mjs";
import {
	ANYTXT_DEFAULT_LIMIT,
	ANYTXT_MAX_LIMIT,
	ANYTXT_RPC_TIMEOUT_MS,
	DEFAULT_ANYTXT_SYNC_TIMEOUT_MS
} from "./components/anytxt/anytxt.mjs";
import { applyAnytxtTools, formatAnytxtOutput } from "./components/anytxt/index.js";
import { formatItem, formatOutput, formatSize, presentCall, presentResult } from "./shared/format.mjs";
import { typeName } from "./shared/type-name.mjs";
import { Config } from "./shared/config.mjs";
import {
	DEFAULT_EXCLUDE_PATHS,
	DEFAULT_MAX_RESULTS,
	MAX_RESULTS_CAP,
	OFFSET_CAP,
	SEARCH_TIMEOUT_MS,
	applyStatusTool,
	applyTool,
	assertSignal,
	buildParameters,
	buildSearch,
	clampOffset,
	createQueryRuntime,
	formatStatus,
	isClearlyMalformed,
	parseArgs,
	parseExclude,
	quotePathScope,
	regexPatterns,
	replaceWorker,
	retireWorker,
	runQuery,
	runQueryUnlocked,
	runtimeFor,
	validateRegexes
} from "./components/everything/index.js";

//#region host-probe
/**
 * Host-capability error codes, kept apart from {@link EVERYTHING_ERROR_CODES}:
 * those describe Everything SDK failures, these describe a DSH host that lacks
 * an interface this plugin registers through.
 */
const HOST_ERROR_CODES = new Map([
	["HOST_CAPABILITY_MISSING", { hint: "a DSH host interface this plugin registers through is missing" }],
	["HOST_MISSING_SIGNAL", { hint: "the tool-call context exposes no AbortSignal (`exec.signal`)" }]
]);

/** One missing-capability failure: capability name, expected/got, code position. */
function hostCapabilityMissing(capability, expected, actual, where, cause) {
	return new EverythingError(`tool-everything: host capability missing — ${capability} (expected ${expected}, got ${actual}). at ${where} · required by dsh-tool-everything; fix: DSH >=0.2.0-rc.1 provides this, on an older host the tool cannot be registered.`, "HOST_CAPABILITY_MISSING", cause === void 0 ? void 0 : { cause });
}

/**
 * Feature-test the DSH interfaces this plugin calls, once at `apply()`.
 * A missing interface fails the load with the capability name, its expected and
 * actual shape, and the code position — never a bare "version mismatch".
 * `systemPrompt.section` is the one soft probe: it is prompt text only, so a
 * host without it keeps the tool and loses the guidance.
 *
 * @returns the soft capabilities that are missing.
 */
function probeHost(ctx, caps = { maxResults: DEFAULT_MAX_RESULTS }) {
	if (typeof defineTool !== "function") throw hostCapabilityMissing("defineTool", "function", typeName(defineTool), "applyTool → defineTool (tool registration)");
	try {
		new (class extends HarnessError {}) ("probe", "HOST_PROBE");
	} catch (error) {
		throw hostCapabilityMissing("HarnessError (subclassable, carries a code)", "class extends Error", typeName(HarnessError), "module load → class EverythingError extends HarnessError", error);
	}
	if (!Number.isFinite(MAX_TIMER_DELAY_MS) || MAX_TIMER_DELAY_MS <= 0) throw hostCapabilityMissing("MAX_TIMER_DELAY_MS", "finite positive number", String(MAX_TIMER_DELAY_MS), "apply() → timeoutMs upper-bound check");
	let defaulted;
	try {
		defaulted = z.object({ probeValue: z.number().default(1) })({});
	} catch (error) {
		throw hostCapabilityMissing("schemastery default filling", "z.object(...)({}) fills defaults", "threw", "module load → Config schema (z.object)", error);
	}
	if (defaulted === null || typeof defaulted !== "object" || defaulted.probeValue !== 1) throw hostCapabilityMissing("schemastery default filling", "{\"probeValue\":1}", JSON.stringify(defaulted), "module load → Config schema (z.object)");
	if (typeof ctx?.tools?.register !== "function") throw hostCapabilityMissing("tools.register", "function", typeName(ctx?.tools?.register), "applyTool → ctx.tools.register");
	let probe;
	try {
		probe = defineTool({
			name: "__host_probe",
			description: "",
			parameters: buildParameters(caps),
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: { type: "boolean", required: true } }
				},
				render: () => [{ type: "text", text: "ok" }]
			},
			execute() {
				return { ok: true };
			}
		});
	} catch (error) {
		throw hostCapabilityMissing(`defineTool(tool definition shape: ${error.message})`, "a compiled tool definition (parameters + output.schema + output.render + execute)", "threw", "applyTool → defineTool(tool definition shape)", error);
	}
	if (typeof probe?.execute !== "function") throw hostCapabilityMissing("defineTool(tool definition shape)", "an object carrying execute", typeName(probe), "applyTool → defineTool(tool definition shape)");
	const soft = [];
	if (typeof ctx?.systemPrompt?.section !== "function") soft.push(`systemPrompt.section (got ${typeName(ctx?.systemPrompt?.section)})`);
	return soft;
}

//#endregion

//#region plugin
/** Cordis plugin name used by loader diagnostics. */
const name = "tool-everything";
/** Services required by the tool. */
const inject = ["tools", "systemPrompt"];

// Config 在 `lib/shared/config.mjs`：一份 schema，外壳与两条组件行共用，不在任何一处复制。

function assertPositiveInteger(field, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`tool-everything: ${field} must be a positive integer`);
}

/**
 * Register the `everything_search` tool. The Everything SDK DLL ships with
 * the package, so registration is unconditional; a broken DLL fails at the
 * first search call, not at plugin load.
 */
async function apply(ctx, config) {
	if (process.platform !== "win32") throw new Error("tool-everything: Windows only");
	const resolved = config ?? {};
	// 缺键一律取默认：外壳行没有 `config:` 块时第二个参数就是 `undefined`，旧写法直接读
	// `resolved.maxResults` 会抛，把整次加载判死。与组件行 `resolveFileCaps` /
	// `resolveContentCaps` 同一条风格：缺键容错，坏值仍当场报错。
	const requestedMaxResults = resolved.maxResults ?? DEFAULT_MAX_RESULTS;
	const requestedTimeoutMs = resolved.timeoutMs ?? SEARCH_TIMEOUT_MS;
	assertPositiveInteger("maxResults", requestedMaxResults);
	assertPositiveInteger("timeoutMs", requestedTimeoutMs);
	// 内容侧与 Everything 同待遇：无条件校验。裸对象调用点没有这两个键，用默认值兜住，
	// 不许因为缺键就把整次加载判死。
	const anytxtTimeoutMs = resolved.anytxtTimeoutMs ?? ANYTXT_RPC_TIMEOUT_MS;
	const anytxtMaxResults = resolved.anytxtMaxResults ?? ANYTXT_DEFAULT_LIMIT;
	assertPositiveInteger("anytxtTimeoutMs", anytxtTimeoutMs);
	assertPositiveInteger("anytxtMaxResults", anytxtMaxResults);
	const anytxtSyncTimeoutMs = resolved.anytxtSyncTimeoutMs ?? DEFAULT_ANYTXT_SYNC_TIMEOUT_MS;
	assertPositiveInteger("anytxtSyncTimeoutMs", anytxtSyncTimeoutMs);
	if (anytxtTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`tool-everything: anytxtTimeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
	if (anytxtSyncTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`tool-everything: anytxtSyncTimeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
	if (requestedTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`tool-everything: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
	const caps = {
		maxResults: Math.min(MAX_RESULTS_CAP, requestedMaxResults),
		timeoutMs: requestedTimeoutMs,
		everythingDllPath: resolved.everythingDllPath,
		autoStart: resolved.autoStart === true,
		anytxtUrl: resolved.anytxtUrl ?? "http://127.0.0.1:9920/rpc",
		anytxtTimeoutMs: resolved.anytxtTimeoutMs ?? ANYTXT_RPC_TIMEOUT_MS,
		anytxtMaxResults: Math.min(ANYTXT_MAX_LIMIT, resolved.anytxtMaxResults ?? ANYTXT_DEFAULT_LIMIT),
		anytxtSyncTimeoutMs
	};
	// The probe compiles the real parameter spec through `defineTool`, so an
	// unsupported schema keyword (this host rejects the whole range/pattern
	// family) fails here as a named HOST_CAPABILITY_MISSING instead of dropping
	// the entire entry at registration and leaving no tool at all.
	const soft = probeHost(ctx, caps);
	if (soft.length > 0) ctx?.logger?.warn?.(`tool-everything: host lacks ${soft.join(", ")}; the everything_search prompt section is skipped, the tool still registers`);
	// 六条工具全由两条组件行自己注册：外壳只做「探测宿主能力 → 组 caps」，不再代注册。
	// 子行裸挂时自带 Config 与默认 caps，`apply` 不依赖外壳喂参数，开关才是真开关。
}
//#endregion

export {
	Config,
	DEFAULT_EXCLUDE_PATHS,
	DEFAULT_MAX_RESULTS,
	EVERYTHING_ERROR_CODES,
	EverythingError,
	HOST_ERROR_CODES,
	MAX_RESULTS_CAP,
	OFFSET_CAP,
	SEARCH_TIMEOUT_MS,
	apply,
	applyAnytxtTools,
	applyStatusTool,
	applyTool,
	assertSignal,
	buildParameters,
	buildSearch,
	clampOffset,
	createQueryRuntime,
	describeLastError,
	formatAnytxtOutput,
	formatItem,
	formatOutput,
	formatSize,
	formatStatus,
	inject,
	isClearlyMalformed,
	name,
	parseArgs,
	parseExclude,
	presentCall,
	presentResult,
	probeEverything,
	probeHost,
	quotePathScope,
	regexPatterns,
	replaceWorker,
	retireWorker,
	runQuery,
	runQueryUnlocked,
	runtimeFor,
	validateRegexes
};

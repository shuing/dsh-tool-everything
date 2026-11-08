// dsh-tool-everything regression verification. Run with: npm run verify
//
// Static assertions always run. The live searches need Everything running: when
// it is not, they print SKIP and the process still exits 0, so a stopped
// Everything never reddens CI. Every path resolves against the repository root
// (no absolute paths, no `bot/` prefix).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const readRepoFile = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");
const plugin = await import(pathToFileURL(path.join(repoRoot, "lib", "index.js")).href);
// 0.4.1：排序取值在 sdk 侧，裸 descending 的语义只能在那一层钉住。
const sdk = await import(pathToFileURL(path.join(repoRoot, "lib", "components", "everything", "sdk.mjs")).href);

const {
	Config,
	DEFAULT_EXCLUDE_PATHS,
	DEFAULT_MAX_RESULTS,
	EverythingError,
	HOST_ERROR_CODES,
	MAX_RESULTS_CAP,
	OFFSET_CAP,
	SEARCH_TIMEOUT_MS,
	assertSignal,
	buildSearch,
	describeLastError,
	formatItem,
	formatOutput,
	parseArgs,
	parseExclude,
	probeHost,
	regexPatterns,
	replaceWorker,
	runtimeFor,
	runQuery
} = plugin;

// VERIFY_REQUIRE_LIVE=1 turns every SKIP into a FAIL, so a machine where
// Everything never ran cannot pass CI silently.
const requireLive = process.env.VERIFY_REQUIRE_LIVE === "1";
let passed = 0;
let skipped = 0;
let failed = 0;
const withDetail = (name, detail) => (detail === void 0 ? name : `${name}  —  ${detail}`);
const pass = (name, detail) => {
	passed += 1;
	console.log(`PASS  ${withDetail(name, detail)}`);
};
const skip = (name, detail) => {
	if (requireLive) {
		failed += 1;
		console.log(`FAIL  LIVE REQUIRED  ${withDetail(name, detail)}`);
		return;
	}
	skipped += 1;
	console.log(`SKIP  ${withDetail(name, detail)}`);
};
const fail = (name, detail) => {
	failed += 1;
	console.log(`FAIL  ${withDetail(name, detail)}`);
};
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));

// --- host capability probing ---
const healthyHost = { tools: { register() {} }, systemPrompt: { section() {} }, logger: { warn() {} } };
try {
	const soft = probeHost(healthyHost);
	check("probeHost passes on a healthy host", Array.isArray(soft) && soft.length === 0, JSON.stringify(soft));
} catch (error) {
	fail("probeHost passes on a healthy host", `${error.code}: ${error.message}`);
}

let missingRegister;
try {
	probeHost({ tools: {}, systemPrompt: { section() {} } });
} catch (error) {
	missingRegister = error;
}
const registerMessage = missingRegister?.message ?? "";
check("ctx.tools={} -> HOST_CAPABILITY_MISSING", missingRegister?.code === "HOST_CAPABILITY_MISSING", missingRegister?.code);
check("message names tools.register and the actual type", /tools\.register/.test(registerMessage) && /got undefined/.test(registerMessage), registerMessage);
check("message names the using function", /applyTool/.test(registerMessage));
check("message carries no drifting line number", !/lib\.index\.js:\d+/.test(registerMessage));
check("HOST_ERROR_CODES holds both host codes", HOST_ERROR_CODES.size === 2 && HOST_ERROR_CODES.has("HOST_CAPABILITY_MISSING") && HOST_ERROR_CODES.has("HOST_MISSING_SIGNAL"), [...HOST_ERROR_CODES.keys()].join(","));

let softProbe;
try {
	softProbe = probeHost({ tools: { register() {} } });
} catch (error) {
	fail("systemPrompt.section is a soft probe", `${error.code}: ${error.message}`);
}
if (softProbe !== void 0) check("systemPrompt.section is a soft probe", softProbe.length === 1 && /systemPrompt\.section/.test(softProbe[0]), JSON.stringify(softProbe));

// A fresh module instance for this one: assertSignal guards a module-level
// one-shot flag, and the live searches below legitimately consume it on the
// main instance — reusing it here would let the check pass on stale state.
const signalModule = await import(`${pathToFileURL(path.join(repoRoot, "lib", "index.js")).href}?case=signal`);
let signalError;
try {
	signalModule.assertSignal({});
} catch (error) {
	signalError = error;
}
const signalMessage = signalError?.message ?? "";
check("missing exec.signal -> HOST_MISSING_SIGNAL", signalError?.code === "HOST_MISSING_SIGNAL", signalError?.code);
check("signal message names runQueryUnlocked, no line number", /runQueryUnlocked/.test(signalMessage) && !/lib\.index\.js:\d+/.test(signalMessage));

// --- the tool definition must compile on this host ---
// `minimum`/`maximum` are JSON Schema keywords the host value-schema DSL does
// not support: a rejected spec throws JsonSchemaError at registration and the
// whole entry is dropped, so the tool vanishes instead of failing loudly.
check("no unsupported schema keywords in module source", !/\b(minimum|maximum)\s*:/.test(readRepoFile("lib/components/everything/index.js")) && !/\b(minimum|maximum)\s*:/.test(readRepoFile("lib/components/anytxt/anytxt.mjs")));
// P2 契约：SDK 绑定与实测常量只有一份（lib/sdk.mjs）。两份必漂，P1 那轮
// flags 漏 FULL_PATH 就是这么来的。
const indexSource = readRepoFile("lib/components/everything/index.js");
const sdkSource = readRepoFile("lib/components/everything/sdk.mjs");
check("the SDK bindings live in one file only", !/koffi\.load/.test(indexSource) && /koffi\.load/.test(sdkSource));
check("no measured SDK constant copied back into lib/index.js", !/SORT_DESCENDING_OFFSET\s*=\s*\d/.test(indexSource) && !/REQUEST_FLAG_/.test(indexSource) && !/11644473600000/.test(indexSource));
// 0.4.10：mtime 必须是整数毫秒。FILETIME 一个 tick 是 100 ns，除 10000 之后并不保证落在整数上——
// 实测宽通配 500 条里 489 条带小数（如 1787382272503.4102），宿主判「无损 JSON」正好不认。取整
// 只许留在 lib/sdk.mjs 那一份里（主线程与 worker 共用），别在 worker 或调用点再写一遍。
check("filetimeToEpochMs rounds to integer milliseconds", /Math\.round\(Number\(koffi\.decode\(buf, "int64"\)\) \/ 10000\) - FILETIME_EPOCH_OFFSET_MS/.test(sdkSource), (sdkSource.match(/return Math\.round[^\n]*/) ?? ["no Math.round in filetimeToEpochMs"])[0]);
let compiledTool;
let compileError;
let promptSection;
try {
	plugin.applyTool({
		systemPrompt: { section(section) { promptSection = section; } },
		tools: { register(tool) { compiledTool = tool; } }
	}, { maxResults: 30, timeoutMs: SEARCH_TIMEOUT_MS });
} catch (error) {
	compileError = error;
}
check("the real tool definition compiles", compileError === void 0 && compiledTool?.name === "everything_search", compileError === void 0 ? "everything_search compiled" : `${compileError.code ?? compileError.name}: ${compileError.message}`);
check("compiled parameters expose every documented argument", Object.keys(compiledTool?.parameters?.properties ?? {}).join(",") === "search,path,pathMustExist,allDrives,maxResults,offset,exclude,sort,descending,countOnly,type", Object.keys(compiledTool?.parameters?.properties ?? {}).join(","));
check("only search is required", Array.isArray(compiledTool?.parameters?.required) && compiledTool.parameters.required.length === 1 && compiledTool.parameters.required[0] === "search", JSON.stringify(compiledTool?.parameters?.required));
// 0.4.8-1：README 参数表与编译出的 schema 互校——十个参数一个都不能漏，以后加参数不更
// 文档先红。顺带钉住两件文档漂过的事：maxResults 的默认值只指向常量、不写死 30（0.3.0
// 收敛过，写回去模型会以为一次只能拿 30 条）；header 的三种形态必须写全，否则模型会去
// 找一个根本不存在的 `Found N of M`。
const readmeParamSource = readRepoFile("README.md");
const schemaParams = Object.keys(compiledTool?.parameters?.properties ?? {});
const undocumentedParams = schemaParams.filter((name) => !readmeParamSource.includes("| `" + name + "` |"));
check("README documents every parameter of the compiled schema", schemaParams.length === 11 && undocumentedParams.length === 0, undocumentedParams.length === 0 ? `${schemaParams.length} parameters documented` : `missing: ${undocumentedParams.join(", ")}`);
check("README points at DEFAULT_MAX_RESULTS instead of pinning 30", /DEFAULT_MAX_RESULTS/.test(readmeParamSource) && !/默认\s*30/.test(readmeParamSource), "no hardcoded 30 default");
check("README spells the three header forms out", readmeParamSource.includes("Found N of M results (offset X)") && readmeParamSource.includes("Found M results") && readmeParamSource.includes("shown N / total M / nextOffset X"), "header forms documented");
// 内容侧三条工具的参数键集、required 与输出形状统一在下面「the anytxt tool face」
// 那段断言：同一份工具面只编译一次，两处各编译一遍只会有两份会漂的期望值。
// 0.4.5：countOnly 与正的 offset 互斥。抛错发生在碰 SDK 之前，所以这条不需要
// Everything 在跑；countOnly 配 offset 0 照旧放行，不重复立断言。
let countOnlyOffsetError;
try {
	await compiledTool.execute({ search: "*.dll", countOnly: true, offset: 5 }, { signal: new AbortController().signal });
} catch (error) {
	countOnlyOffsetError = error;
}
check("countOnly with a positive offset is rejected, naming both arguments and the reason", countOnlyOffsetError instanceof Error && /countOnly/.test(countOnlyOffsetError.message) && /offset/.test(countOnlyOffsetError.message) && /total/.test(countOnlyOffsetError.message) && /SDK cannot report how many matches remain/.test(countOnlyOffsetError.message), countOnlyOffsetError === void 0 ? "no error thrown" : countOnlyOffsetError.message);
// 0.4.6-3：sort 非法值给近亲建议。别名优先（`mtime` 到 `dateModified` 编辑距离是 8，纯距离法
// 永远给不出建议），距离阈值 <= 2，都不中只列白名单。抛错发生在碰 SDK 之前，非 live。
check("a near-miss sort key resolves to the whitelisted one", sdk.closestSortKey("mtime") === "dateModified" && sdk.closestSortKey("date") === "dateModified" && sdk.closestSortKey("created") === "dateCreated" && sdk.closestSortKey("sise") === "size" && sdk.closestSortKey("DateModified") === "dateModified" && sdk.closestSortKey("zzz") === void 0, `mtime ${sdk.closestSortKey("mtime")}, date ${sdk.closestSortKey("date")}, sise ${sdk.closestSortKey("sise")}, zzz ${sdk.closestSortKey("zzz")}`);
let sortTypoError;
try {
	await compiledTool.execute({ search: "*.dll", sort: "mtime" }, { signal: new AbortController().signal });
} catch (error) {
	sortTypoError = error;
}
check("a bad sort value names the key it probably meant", sortTypoError instanceof Error && /sort must be one of/.test(sortTypoError.message) && /did you mean "dateModified"/.test(sortTypoError.message), sortTypoError === void 0 ? "no error thrown" : sortTypoError.message);
let sortJunkError;
try {
	await compiledTool.execute({ search: "*.dll", sort: "zzz" }, { signal: new AbortController().signal });
} catch (error) {
	sortJunkError = error;
}
check("a junk sort value lists the whitelist without inventing a suggestion", sortJunkError instanceof Error && /sort must be one of name, path, size, dateModified, dateCreated/.test(sortJunkError.message) && !/did you mean/.test(sortJunkError.message), sortJunkError === void 0 ? "no error thrown" : sortJunkError.message);
// 显示层契约：prompt 段要把新能力教给模型，否则 schema 里有、模型也不会用。这段文案
// 原先没有任何断言兜着，换短版时最容易悄悄丢掉四句能力。
const promptText = promptSection?.text ?? "";
// 0.4.11：文案只留两处唯一来源——工具 description（语法与跨参数规则）与各参数 description；
// prompt 只剩用途分工与汇报纪律。断言跟着文案走，钉在唯一那份上，标准一条不放宽。
const toolDoc = compiledTool?.description ?? "";
check("the tool description teaches sort/countOnly/mtime", toolDoc.length > 0 && ["sort", "countOnly", "mtime"].every((word) => toolDoc.includes(word)) && /descending/.test(toolDoc), `${toolDoc.length} chars in the tool description, sort/descending/countOnly/mtime present`);
// 0.4.6-2：regex 的引号形态是既有能力（lib/index.js 的 regex 解析从 0.3.0 就支持），漂的是文案。
// 0.4.11 起唯一那份在工具 description：钉住它必须教引号形态、且不许写「ends at its first space」
// 这种绝对话；prompt 只负责把「内容检索归 grep」这条分工讲清。
check("the docs teach the quoted regex: form, not a space cutoff", toolDoc.includes("regex:\"") && /double-quoted/.test(toolDoc) && !/ends at its first space/i.test(toolDoc) && promptText.includes("grep"), `desc quoted ${toolDoc.includes("regex:\"")}, double-quoted ${/double-quoted/.test(toolDoc)}, prompt grep ${promptText.includes("grep")}`);
// 文案互校：descending 的 schema 描述、prompt 段、sdk.sortValueFor 三处必须同口径——
// sort 缺省时 descending:true 就是 name 降序（默认序反序），不是「忽略」。原先 schema
// 描述写着 Ignored when，跟实现正好相反，而这种矛盾只有人眼比对才发现，所以钉成断言。
const descendingDoc = compiledTool?.parameters?.properties?.descending?.description ?? "";
// 「not ignored」是正确措辞本身要用的短语，先剔除再查残留的 ignored，否则这条断言
// 会把正确文案判成违规（第一版就是这么红的）。禁的是「Ignored when sort is omitted」。
const descendingDocResidual = descendingDoc.replace(/not ignored/gi, "");
check("descending's schema text says name descending, never ignored", /name descending/.test(descendingDoc) && !/ignored/i.test(descendingDocResidual), descendingDoc);
check("schema text and tool description agree on bare descending", /name descending/.test(descendingDoc) && /name[- ]descending/.test(toolDoc), `${descendingDoc.slice(0, 60)}… / tool description ${/name[- ]descending/.test(toolDoc)}`);
// 0.4.8-2：prompt 补报告纪律与 dbLoaded 条件句。钉两件事：报告三段（命中概况 → 已核验\n// 路径 → 后续动作）与「候选，未核验」标注真的在；dbLoaded 只能是条件句——工具没有\n// 探测服务的能力，写成「先确认服务在运行」就是教模型做它做不到的事。\ncheck("the prompt carries the report discipline and the verified-path rule", /Report in three steps/.test(promptText) && /candidate, unverified/.test(promptText) && /read or glob/.test(promptText), `${promptText.length} chars, three-step report present`);
// 前提变了：0.4.14 起有了 everything_status，工具 description 里那句「this tool cannot probe」
// 就是假话，断言必须跟着事实走——钉「搜索本身不探活、探测归 everything_status」，
// 「先确认服务在运行」仍然是禁区（那是教模型做它做不到的事）。
check("dbLoaded is taught as a condition, probing belongs to everything_status", /dbLoaded/.test(toolDoc) && /a search never probes/.test(toolDoc) && /everything_status/.test(toolDoc) && !/confirm the Everything service is running/i.test(toolDoc), `dbLoaded ${/dbLoaded/.test(toolDoc)}, search never probes ${/a search never probes/.test(toolDoc)}, everything_status ${/everything_status/.test(toolDoc)}`);
// 0.4.11：prompt 只剩「用途分工 + 汇报纪律」两句半，语法与跨参数规则归工具 description、
// 细则归各参数 description。上限从 1400 压到 400——以后谁想往 prompt 里堆句子，先删一句。
// 0.4.15：按用户要求在最前面加 B 版两行「工作前先搜一遍 / 缺东西先搜」（+161 字符，374 → 535），
// 门槛跟着实测抬到 560，留 25 字符余量；规矩不变：想再加一句，先删一句。
check("the prompt section stays within its 560-character budget", promptText.length > 0 && promptText.length <= 560, `${promptText.length} chars`);
// 0.4.13：toolDoc 六段化后实测 1442 字符，钉一个 1600 的上限——工具 description 每轮都在上下文里，
// 与 prompt 一样会靠堆句子长回去，这条逼以后谁想加一句先删一句。
check("the tool description stays within its 1600-character budget", toolDoc.length > 0 && toolDoc.length <= 1600, `${toolDoc.length} chars in the tool description`);
// 0.4.13：六段段名与顺序钉死（Usage → Principle → Constraints → Semantics → Report → Scope），
// 参数在前、报告在后；有人把段名写成单数或打乱顺序，这条先红。
const sectionOrder = ["Usage:", "Principle:", "Constraints:", "Semantics:", "Report:", "Scope:"].map((label) => toolDoc.indexOf(label));
check("the tool description keeps the six sections in order", sectionOrder.every((index) => index >= 0) && sectionOrder.every((index, position) => position === 0 || index > sectionOrder[position - 1]), JSON.stringify(sectionOrder));
// Scope 段不许再重复默认条数与上限——那在 Semantics 里一次就够（0.4.12 刚删掉这处重复）。
const scopeSection = toolDoc.slice(toolDoc.indexOf("Scope:"));
check("the Scope section does not repeat the default cap", scopeSection.length > 0 && !/cap(?:ped)? at/i.test(scopeSection) && !/defaults to/i.test(scopeSection) && /exclude:""/.test(scopeSection), scopeSection);

// P2-a：description 与常量的互校。期望串一律由导出的 DEFAULT_MAX_RESULTS / MAX_RESULTS_CAP /
// DEFAULT_EXCLUDE_PATHS 拼出来，再用 includes 对整段比对——拿正则去抓数字会在描述改写时把
// 「文案变了」误报成「常量漂了」。这次编译的 caps.maxResults 直接取 DEFAULT_MAX_RESULTS，
// 断的是真默认值，不是上面那次 maxResults: 30 的探针值。
let defaultTool;
let defaultCompileError;
try {
	plugin.applyTool({
		systemPrompt: { section() {} },
		tools: { register(tool) { defaultTool = tool; } }
	}, { maxResults: DEFAULT_MAX_RESULTS, timeoutMs: SEARCH_TIMEOUT_MS });
} catch (error) {
	defaultCompileError = error;
}
const defaultToolDoc = defaultTool?.description ?? "";
const defaultParams = defaultTool?.parameters?.properties ?? {};
const defaultScopeSection = defaultToolDoc.slice(defaultToolDoc.indexOf("Scope:"));
check("the tool description states the maxResults default and cap from the constants", defaultCompileError === void 0 && defaultToolDoc.includes(`maxResults defaults to ${DEFAULT_MAX_RESULTS}, capped at ${MAX_RESULTS_CAP}`), defaultCompileError === void 0 ? `default ${DEFAULT_MAX_RESULTS}, cap ${MAX_RESULTS_CAP}` : `${defaultCompileError.code ?? defaultCompileError.name}: ${defaultCompileError.message}`);
check("the maxResults parameter description states that same cap and default", (defaultParams.maxResults?.description ?? "").includes(`1–${MAX_RESULTS_CAP}`) && (defaultParams.maxResults?.description ?? "").includes(`default ${DEFAULT_MAX_RESULTS}`), defaultParams.maxResults?.description);
check("the exclude parameter description states the same default exclusions", (defaultParams.exclude?.description ?? "").includes(`Defaults to ${DEFAULT_EXCLUDE_PATHS.join("; ")}`), defaultParams.exclude?.description);
check("the tool description's Scope section names those same exclusions", defaultScopeSection.includes(`default exclusions ${DEFAULT_EXCLUDE_PATHS.join("; ")}`), defaultScopeSection);
// 上面四条全是「描述 vs 常量」的互校，期望串由常量自己拼：常量漂了它们照样全绿（实测把
// DEFAULT_MAX_RESULTS 改成 200，四条仍是 PASS）。所以这里故意留唯一一处字面量，和
// MEASURED_SDK_CONSTANTS 同一套路——常量被改，这条先红，再由人决定改文档还是改回常量。
check("DEFAULT_MAX_RESULTS and MAX_RESULTS_CAP keep their documented values", DEFAULT_MAX_RESULTS === 100 && MAX_RESULTS_CAP === 500, `${DEFAULT_MAX_RESULTS} / ${MAX_RESULTS_CAP}`);
// P2-b：everything_status 的守门人断言。「模型视图不给修复步骤」的真正守门人不是「有这个工具」，
// 而是「键集恰为这五个、且 state/detail/hint 一个都不在」——多一个 state 就够模型去找环境。
let statusTool;
let statusCompileError;
try {
	plugin.applyStatusTool({
		systemPrompt: { section() {} },
		tools: { register(tool) { statusTool = tool; } }
	}, { maxResults: DEFAULT_MAX_RESULTS, timeoutMs: SEARCH_TIMEOUT_MS });
} catch (error) {
	statusCompileError = error;
}
const statusParamKeys = Object.keys(statusTool?.parameters?.properties ?? {});
check("the tool table carries everything_status with no parameters", statusCompileError === void 0 && statusTool?.name === "everything_status" && statusParamKeys.length === 0, statusCompileError === void 0 ? `everything_status compiled, ${statusParamKeys.length} parameters` : `${statusCompileError.code ?? statusCompileError.name}: ${statusCompileError.message}`);
const statusSchema = statusTool?.output?.schema ?? {};
const statusSchemaKeys = Object.keys(statusSchema.properties ?? {}).sort();
check("everything_status's output keys are exactly the five model-facing fields", JSON.stringify(statusSchemaKeys) === JSON.stringify(["code", "message", "ok", "path", "version"]), JSON.stringify(statusSchemaKeys));
check("everything_status's output schema allows no extra properties", statusSchema.additionalProperties === false, String(statusSchema.additionalProperties));
// 显式断三个禁键：state 会引出「为什么」，detail 会引出修复步骤，hint 直接就是修复步骤。
const forbiddenStatusKeys = ["state", "detail", "hint"].filter((key) => statusSchemaKeys.includes(key));
check("everything_status exposes no state/detail/hint keys", forbiddenStatusKeys.length === 0, forbiddenStatusKeys.length === 0 ? "no state/detail/hint in the output schema" : `leaked: ${forbiddenStatusKeys.join(", ")}`);
// status 的 600 预算：描述 389 字符，与 prompt 的 400、toolDoc 的 1600 同口径按实算字符数断。
const statusDoc = statusTool?.description ?? "";
check("the status description stays within its 600-character budget", statusDoc.length > 0 && statusDoc.length <= 600, `${statusDoc.length} chars in the status description`);
// P2-c→P2-d：键集守住的是「结构里没有修复字段」，守不住「message 文案里写修复步骤」；只扫
// 三条 Map 判决同样守不住四条内联 message——往 SDK 未加载那条塞一句「please install
// Everything SDK」，键集和三条判决全绿（实测过）。所以下面按槽位取每一条模型可见的字面量
// 一起断：三条 Map 判决 + 四条内联（SDK 未加载 / 探活失败 / 预算超时 / 探活早退）+ 兜底串
// 「the probe reported <code>」。判据仍是「非空 且 不含指向环境的动词」；不扫全文，注释里
// 那句「不代表索引状态」的说明不当修复话术算。
const statusSource = readRepoFile("lib/components/everything/status.mjs");
const repairWords = /install|download|enable|launch|start|restart|settings/i;
const verdictMessages = ["STATUS_INDEX_NOT_LOADED", "STATUS_SKIPPED", "STATUS_ABORTED"].map((code) => {
	const match = new RegExp(`\\[${code},\\s*"((?:[^"\\\\]|\\\\.)*)"\\]`).exec(statusSource);
	return { code, text: match?.[1] ?? "" };
});
// 四条内联 message 与兜底串：同一把尺子，只按槽位取字面量，不扫全文。
const inlineMessages = [...statusSource.matchAll(/message:\s*`((?:[^`\\]|\\.)*)`/g)].map((match) => match[1]);
const fallbackMessage = /VERDICT_MESSAGES\.get\(code\) \?\? `((?:[^`\\]|\\.)*)`/.exec(statusSource)?.[1] ?? "";
const allStatusMessages = [
	...verdictMessages.map((entry) => ({ label: entry.code, text: entry.text })),
	...inlineMessages.map((text, index) => ({ label: `inline message #${index + 1}`, text })),
	{ label: "fallback the probe reported <code>", text: fallbackMessage }
];
const emptyMessages = allStatusMessages.filter((entry) => entry.text.length === 0).map((entry) => entry.label);
check("every model-facing status message is non-empty", emptyMessages.length === 0, emptyMessages.length === 0 ? `${allStatusMessages.length} message literals, 3 verdict + ${inlineMessages.length} inline + 1 fallback` : `empty or unparsed: ${emptyMessages.join(", ")}`);
const repairSaying = allStatusMessages.filter((entry) => repairWords.test(entry.text)).map((entry) => entry.label);
check("no status message tells the model to go fix the environment", repairSaying.length === 0, repairSaying.length === 0 ? `no install/download/enable/launch/start/restart/settings in ${allStatusMessages.length} message literals` : `repair wording in: ${repairSaying.join(", ")}`);

// --- the anytxt tool face (content search, off by default) ---
// 三工具是第二条工具面，Everything 那条链路一行不动，所以这里单独编译一份：钉参数键集、
// 输出形状、描述预算与 prompt 段。任何一条红，都说明内容侧的接线与文档脱了榫。
const anytxtCaps = { anytxtUrl: "http://127.0.0.1:9920/rpc", anytxtTimeoutMs: 15000, anytxtMaxResults: 20, anytxtSyncTimeoutMs: 60000, timeoutMs: SEARCH_TIMEOUT_MS, maxResults: DEFAULT_MAX_RESULTS };
const anytxtTools = new Map();
let anytxtSection;
let anytxtCompileError;
try {
	plugin.applyAnytxtTools({
		systemPrompt: { section(section) { anytxtSection = section; } },
		tools: { register(tool) { anytxtTools.set(tool.name, tool); } }
	}, anytxtCaps);
} catch (error) {
	anytxtCompileError = error;
}
check("the four anytxt tools compile", anytxtCompileError === void 0 && ["anytxt_search", "anytxt_read", "anytxt_status", "anytxt_sync_index"].every((name) => anytxtTools.has(name)), anytxtCompileError === void 0 ? [...anytxtTools.keys()].join(",") : `${anytxtCompileError.code ?? anytxtCompileError.name}: ${anytxtCompileError.message}`);
const anytxtSearchParams = Object.keys(anytxtTools.get("anytxt_search")?.parameters?.properties ?? {}).join(",");
// P1-5：`exclude` 是第七个参数（与 everything_search 对齐），默认三条排除、空串关闭。
check("anytxt_search exposes exactly its seven arguments", anytxtSearchParams === "pattern,dir,ext,limit,offset,order,exclude", anytxtSearchParams);
check("anytxt_search requires pattern and dir", JSON.stringify(anytxtTools.get("anytxt_search")?.parameters?.required ?? []) === JSON.stringify(["pattern", "dir"]), JSON.stringify(anytxtTools.get("anytxt_search")?.parameters?.required));
const anytxtReadParams = Object.keys(anytxtTools.get("anytxt_read")?.parameters?.properties ?? {}).join(",");
check("anytxt_read exposes exactly its five arguments", anytxtReadParams === "ref,mode,query,offset,max", anytxtReadParams);
check("anytxt_read requires only ref", JSON.stringify(anytxtTools.get("anytxt_read")?.parameters?.required ?? []) === JSON.stringify(["ref"]), JSON.stringify(anytxtTools.get("anytxt_read")?.parameters?.required));
check("anytxt_status takes no parameters", Object.keys(anytxtTools.get("anytxt_status")?.parameters?.properties ?? {}).length === 0, JSON.stringify(Object.keys(anytxtTools.get("anytxt_status")?.parameters?.properties ?? {})));
// syncIndex 只有 folder 一个参数，且必填：实测两种形态（无盘符路径、目录不存在）都回 errno 0，
// 校验只能落在插件侧，所以这条参数在 schema 上必须被标成必填。正斜杠不在此列——它先归一成
// 反斜杠（anytxt.verify.mjs 有一条钉这个），不属于「当场报错」的那一类。
const anytxtSyncParams = Object.keys(anytxtTools.get("anytxt_sync_index")?.parameters?.properties ?? {}).join(",");
check("anytxt_sync_index exposes exactly folder, and requires it", anytxtSyncParams === "folder" && JSON.stringify(anytxtTools.get("anytxt_sync_index")?.parameters?.required ?? []) === JSON.stringify(["folder"]), `${anytxtSyncParams} / ${JSON.stringify(anytxtTools.get("anytxt_sync_index")?.parameters?.required)}`);
const anytxtSyncOutKeys = Object.keys(anytxtTools.get("anytxt_sync_index")?.output?.schema?.properties ?? {}).sort();
check("anytxt_sync_index's output keys stay folder/code/message/ok", JSON.stringify(anytxtSyncOutKeys) === JSON.stringify(["code", "folder", "message", "ok"]), JSON.stringify(anytxtSyncOutKeys));
const anytxtStatusSchema = anytxtTools.get("anytxt_status")?.output?.schema ?? {};
const anytxtStatusKeys = Object.keys(anytxtStatusSchema.properties ?? {}).sort();
check("anytxt_status exposes exactly ok/code/message/url", JSON.stringify(anytxtStatusKeys) === JSON.stringify(["code", "message", "ok", "url"]), JSON.stringify(anytxtStatusKeys));
check("anytxt_status's output schema allows no extra properties", anytxtStatusSchema.additionalProperties === false, String(anytxtStatusSchema.additionalProperties));
const anytxtForbiddenKeys = ["state", "detail", "hint", "version"].filter((key) => anytxtStatusKeys.includes(key));
check("anytxt_status exposes no state/detail/hint/version keys", anytxtForbiddenKeys.length === 0, anytxtForbiddenKeys.length === 0 ? "no state/detail/hint/version in the output schema" : `leaked: ${anytxtForbiddenKeys.join(", ")}`);
const anytxtBudgets = ["anytxt_search", "anytxt_read", "anytxt_status", "anytxt_sync_index"].map((name) => [name, (anytxtTools.get(name)?.description ?? "").length]);
check("each anytxt description stays within its 1200-character budget", anytxtBudgets.every(([, length]) => length > 0 && length <= 1200), anytxtBudgets.map(([name, length]) => `${name} ${length}`).join(", "));
check("the anytxt prompt is one section at order 3255 within 400 characters", anytxtSection?.name === "tool:anytxt_search" && anytxtSection?.order === 3255 && typeof anytxtSection?.text === "string" && anytxtSection.text.length > 0 && anytxtSection.text.length <= 400, `${anytxtSection?.name} order ${anytxtSection?.order}, ${anytxtSection?.text?.length ?? 0} chars`);
const anytxtPromptText = anytxtSection?.text ?? "";
check("the anytxt prompt keeps the division of labour and the freshness note", /anytxt_search/.test(anytxtPromptText) && /everything_search/.test(anytxtPromptText) && /grep/.test(anytxtPromptText) && /may be stale/.test(anytxtPromptText), anytxtPromptText);
const anytxtItemSchema = anytxtTools.get("anytxt_search")?.output?.schema?.properties?.items?.items?.properties ?? {};
// 键集判据不放宽（仍须恰为这四项），但不把属性顺序当契约：编译后的属性表顺序不是 schema 语义。
// 键集判据不放宽（仍须恰为这四项），但不把属性顺序当契约，也不在嵌套项上读叶子 required：
// 本宿主的定义把必填提升到 parameters.required / output.schema.required，叶子上读不到，
// 读它就等于把「必填」判成永假（上一版正是这么红的，键集其实一直是对的）。
check("an anytxt hit carries ref/path plus optional size/modified", Object.keys(anytxtItemSchema).sort().join(",") === "modified,path,ref,size" && anytxtItemSchema.ref?.type === "string" && anytxtItemSchema.path?.type === "string", Object.keys(anytxtItemSchema).join(","));
check("an anytxt page always carries the freshness note", /indexed copy, may be stale/.test(plugin.formatAnytxtOutput({ items: [], total: 0, truncated: false, offset: 0 })), plugin.formatAnytxtOutput({ items: [], total: 0, truncated: false, offset: 0 }).split("\n")[0]);
// P0-1：ref 必须在**模型可见的那一行**里，否则 anytxt_read 没有任何入口（fid 无法从路径推导）。
// P1-5：排除条数要进结果头；0 条时不印，否则每页都挂一句无用提示。
const anytxtRendered = plugin.formatAnytxtOutput({ items: [{ ref: "anytxt:13846853177875364149", path: "C:\\docs\\a.pdf", size: 1234, modified: "2026-10-17T23:02:28.000Z" }], total: 1, truncated: false, offset: 0, excluded: 3 });
check("an anytxt hit line renders the ref as its first column", anytxtRendered.split("\n\n")[1]?.split("\t")[0] === "anytxt:13846853177875364149", anytxtRendered.replace(/\n/g, " | "));
// 0.5.1：`modified` 是索引回的 ISO(UTC)，模型可见那一列必须是**本地**时间。旧实现只把
// `T`／`Z` 去掉就印，同一个文件会比 everything_search 那一列早一个时区（本机 8 小时），
// 两边又都没有时区标记。期望值在测试里用自己的日期算术算出来，不复用生产的格式化函数。
const anytxtStampCell = anytxtRendered.split("\n\n")[1]?.split("\t")[3];
const stampAt = new Date("2026-10-17T23:02:28.000Z");
const pad2 = (value) => String(value).padStart(2, "0");
const expectedLocalStamp = `${stampAt.getFullYear()}-${pad2(stampAt.getMonth() + 1)}-${pad2(stampAt.getDate())} ${pad2(stampAt.getHours())}:${pad2(stampAt.getMinutes())}:${pad2(stampAt.getSeconds())}`;
const utcWallClock = stampAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
check("an anytxt hit renders modified in local time, not the raw UTC wall clock", anytxtStampCell === expectedLocalStamp, `rendered ${anytxtStampCell} | local ${expectedLocalStamp} | UTC wall clock ${utcWallClock}`);
check("an anytxt hit with no modified prints a dash, and an unusable one does too", plugin.formatAnytxtOutput({ items: [{ ref: "anytxt:1", path: "C:\\a.txt" }], total: 1, truncated: false }).split("\n\n")[1] === "anytxt:1\tC:\\a.txt\t-\t-" && plugin.formatAnytxtOutput({ items: [{ ref: "anytxt:1", path: "C:\\a.txt", modified: "not-a-date" }], total: 1, truncated: false }).split("\n\n")[1].endsWith("\t-"), "missing and unusable timestamps both print a dash");
check("the anytxt header reports the exclusion rules in force", /\(3 exclusion rules applied\)/.test(anytxtRendered) && !/exclusion rule/.test(plugin.formatAnytxtOutput({ items: [], total: 0, truncated: false, offset: 0, excluded: 0 })), anytxtRendered.split("\n")[0]);
// max 是两模式共用的参数（fragments 段数 1-8、full 字符数 1-40000），早期实现把
// max 与 offset 一起当 full 专属拒掉，本条钉住那个回归。判据只看「参数层放行」，不看网络结果：
// 端点故意指向没人听的 127.0.0.1:9，参数被拒时拿到的才是 ANYTXT_INVALID_ARGUMENT。
const offlineTools = new Map();
plugin.applyAnytxtTools({ tools: { register(tool) { offlineTools.set(tool.name, tool); } } }, { ...anytxtCaps, anytxtUrl: "http://127.0.0.1:9/rpc", anytxtTimeoutMs: 2000 });
const offlineRead = offlineTools.get("anytxt_read");
let fragmentsMaxError;
let fragmentsOffsetError;
try {
	await offlineRead.execute({ ref: "anytxt:1", mode: "fragments", query: "x", max: 2 }, { signal: new AbortController().signal });
} catch (error) {
	fragmentsMaxError = error;
}
try {
	await offlineRead.execute({ ref: "anytxt:1", mode: "fragments", query: "x", offset: 1 }, { signal: new AbortController().signal });
} catch (error) {
	fragmentsOffsetError = error;
}
check("fragments accepts max but rejects offset", fragmentsMaxError?.code !== "ANYTXT_INVALID_ARGUMENT" && fragmentsOffsetError?.code === "ANYTXT_INVALID_ARGUMENT" && /offset belongs to mode full/.test(fragmentsOffsetError?.message ?? ""), `max path: ${fragmentsMaxError?.code ?? "no error thrown"}, offset path: ${fragmentsOffsetError?.code ?? "no error thrown"}`);
// order 是 anytxt_search 的第六个参数：白名单在 execute 拦，非法值必须当场是
// ANYTXT_INVALID_ARGUMENT 并列出五个合法值。端点故意指向没人听的 127.0.0.1:9，
// 参数层被拒时拿到的才是参数错误，而不是网络错误。
const offlineSearch = offlineTools.get("anytxt_search");
let orderRejected;
try {
	await offlineSearch.execute({ pattern: "x", dir: "C:\\docs", order: 9 }, { signal: new AbortController().signal });
} catch (error) {
	orderRejected = error;
}
check("an out-of-range order is a named argument error", orderRejected?.code === "ANYTXT_INVALID_ARGUMENT" && /order must be one of 0, 1, 2, 3, 4/.test(orderRejected?.message ?? ""), `${orderRejected?.code ?? "no error thrown"}: ${orderRejected?.message ?? ""}`);

// 无条件注册：没有 anytxtEnabled 这道闸，装好即用，与 everything_search 同待遇。
// 判的是「这个开关从代码与文档里一起消失」，不是「某个函数被调用」。
const anytxtSwitchLeft = ["lib/index.js", "README.md"].filter((relative) => /anytxtEnabled/.test(readRepoFile(relative)));
check("the AnyTxt tools need no enable switch", anytxtSwitchLeft.length === 0, anytxtSwitchLeft.length === 0 ? "no anytxtEnabled in lib/index.js or README.md" : `still gated in: ${anytxtSwitchLeft.join(", ")}`);

// --- declared ranges and bundle config ---
const pkg = JSON.parse(readRepoFile("package.json"));
check("engines.dsh", pkg.engines?.dsh === ">=0.2.0-rc.1 <1.0.0", pkg.engines?.dsh);
const dshPeers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith("@deepseek-ai/") && name !== "@deepseek-ai/schemastery");
check("four DSH peers, all >=0.2.0-rc.1 <1.0.0", dshPeers.length === 4 && dshPeers.every(([, range]) => range === ">=0.2.0-rc.1 <1.0.0"), dshPeers.map(([name, range]) => `${name}=${range}`).join(" "));
check("schemastery peer untouched", pkg.peerDependencies?.["@deepseek-ai/schemastery"] === "^3.18.1", pkg.peerDependencies?.["@deepseek-ai/schemastery"]);
check("no <0.3.0-0 left in package.json", !/0\.3\.0-0/.test(readRepoFile("package.json")));
// 版本号只在一处维护：`package.json` 的 version 是唯一事实来源，README 顶部那句
// 「请确认安装的是 **X.Y.Z 及以上**」必须与它同值、且形如 x.y.z。两处文件互校——
// 钉字面量的断言每升一版都要跟着改，迟早被人为改绿。
const readmeVersion = /安装的是 \*\*(\d+\.\d+\.\d+) 及以上\*\*/.exec(readRepoFile("README.md"))?.[1];
check("package.json version looks like x.y.z", /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
check("README's minimum version matches package.json", readmeVersion !== void 0 && readmeVersion === pkg.version, `README ${readmeVersion ?? "not found"} vs package.json ${pkg.version}`);
check("scripts.verify is wired", pkg.scripts?.verify === "node test/verify.mjs", pkg.scripts?.verify);
// P2-f：产物的门。行为断言照不出「本地全绿、打包缺文件」——files 漏一个模块、worker 入口换了名，
// verify 跑仓库目录永远绿；`npm pack --dry-run` 才照得出。把它固定成一条 script，别每次靠人记得手敲。
check("scripts.pack:check is wired", pkg.scripts?.["pack:check"] === "npm pack --dry-run", pkg.scripts?.["pack:check"]);
// scripts.verify 与 README 都让人跑 test/verify.mjs，发布件里就必须带着它，否则装出来
// 一跑就 ENOENT——这条断的是「声明的入口在包里存在」，不是文案。
check("files ships the verify script", Array.isArray(pkg.files) && pkg.files.includes("test/verify.mjs"), (pkg.files ?? []).join(","));
// P2-e→P2-f：缺陷一的守门人。P1 新增 lib/status.mjs 时漏掉 files 这一行——本地按目录加载所以 113 条
// 全绿，一旦 npm pack 就缺文件，lib/index.js 的引用直接 ERR_MODULE_NOT_FOUND。断的是「被引用的模块
// 必须进包」这条关系本身，不手抄清单：手抄的下次照样漏。目录项 "lib" 视为覆盖全部 lib 条目，与 npm
// 的 files 语义一致。
// 但引用有两种形态，只抽 import 语句会漏掉 worker 入口：lib/paths.mjs（workerUrl） 的
// new URL("./components/everything/query-worker.mjs", import.meta.url) 不走 import，改名或挪目录后打包会静默缺文件、
// 断言照样绿，运行时才 new Worker(fileURLToPath(WORKER_URL)) 报 ENOENT。所以取两种形态的并集，
// 抽到的条数从 2 变 3，判据从「>= 2」变「>= 3」。
const indexSourceForImports = readRepoFile("lib/index.js");
const importedSpecifiers = [...indexSourceForImports.matchAll(/from\s+"(\.\/[^"]+\.(?:mjs|js))"/g)].map((match) => match[1]);
const workerSpecifiers = [...indexSourceForImports.matchAll(/new URL\(\s*"(\.\/[^"]+\.(?:mjs|js))"\s*,\s*import\.meta\.url\s*\)/g)].map((match) => match[1]);
const indexImportSpecifiers = [...new Set([...importedSpecifiers, ...workerSpecifiers])].map((specifier) => `lib/${specifier.replace("./", "")}`);
const shippedFiles = Array.isArray(pkg.files) ? pkg.files : [];
const unshippedImports = indexImportSpecifiers.filter((relative) => !shippedFiles.includes(relative) && !shippedFiles.includes("lib"));
check("every module lib/index.js references is shipped in files", indexImportSpecifiers.length >= 3 && unshippedImports.length === 0, unshippedImports.length === 0 ? `${indexImportSpecifiers.length} referenced modules all shipped: ${indexImportSpecifiers.join(", ")}` : `not shipped: ${unshippedImports.join(", ")}`);
// 3b：worker 入口与 DLL 路径都搬进 lib/paths.mjs，上面那条守门（只扫 lib/index.js 的 new URL）
// 搬完就扫不到对象、空转变绿。重锚到这里：两条路径必须真解析到随包发行的文件，且本文件是唯一定义处。
const pathsSource = readRepoFile("lib/paths.mjs");
const workerSpecifier = /new URL\(\s*"(\.\/[^"]+\.mjs)"\s*,\s*import\.meta\.url\s*\)/.exec(pathsSource)?.[1];
const dllSpecifier = /new URL\(\s*"(\.\.\/native\/[^"]+)"\s*,\s*import\.meta\.url\s*\)/.exec(pathsSource)?.[1];
check("lib/paths.mjs carries the one DLL path and the one worker entry, both shipped", workerSpecifier === "./components/everything/query-worker.mjs" && dllSpecifier === "../native/Everything64.dll" && shippedFiles.includes(`lib/${workerSpecifier.replace("./", "")}`) && shippedFiles.includes(dllSpecifier.replace("../", "")), `${dllSpecifier} | ${workerSpecifier}`);
const patchText = readRepoFile("cordis.patch.yml");
check("cordis.patch.yml keeps timeoutMs at 8000", /^\s*timeoutMs:\s*8000\s*$/m.test(patchText), /timeoutMs:\s*\d+/.exec(patchText)?.[0]);

// --- search string, error mapping, formatting ---
check("SEARCH_TIMEOUT_MS is 8000", SEARCH_TIMEOUT_MS === 8e3, String(SEARCH_TIMEOUT_MS));
check("default exclusions are the three documented ones", JSON.stringify(DEFAULT_EXCLUDE_PATHS) === JSON.stringify(["$RECYCLE.BIN", "System Volume Information", "WinSxS"]), DEFAULT_EXCLUDE_PATHS.join(" | "));

let invalidRegex;
try {
	parseArgs({ search: "regex:[" });
} catch (error) {
	invalidRegex = error;
}
check("regex:[ -> INVALID_REGEX", invalidRegex instanceof EverythingError && invalidRegex.code === "INVALID_REGEX", invalidRegex?.code);
const passThrough = ["regex:^(?!x).*$", "regex:\\(?hi\\)", "plain words *.dll"];
const passThroughOk = passThrough.every((search) => {
	try {
		parseArgs({ search });
		return true;
	} catch {
		return false;
	}
});
check("legal-but-odd regex clauses pass through", passThroughOk, passThrough.join(" | "));
// 引号形态整段取，未闭合引号回退 \S+（不抛错），这是 regexPatterns 的新契约。
const quotedPatterns = regexPatterns('regex:"a b" regex:c');
check("regex: 引号形态取引号内整段", JSON.stringify(quotedPatterns) === JSON.stringify(["a b", "c"]), JSON.stringify(quotedPatterns));
let unclosedQuoteThrew = false;
try {
	parseArgs({ search: 'regex:"unclosed' });
} catch (error) {
	unclosedQuoteThrew = true;
}
check("an unclosed regex: quote falls back instead of throwing", !unclosedQuoteThrew);

check("lastError 2 keeps its specific name", describeLastError(2).code === "EVERYTHING_NOT_RUNNING" && /lastError=2/.test(describeLastError(2).message), describeLastError(2).message);
check("unknown lastError passes its number through", describeLastError(99).code === "EVERYTHING_ERROR_99", describeLastError(99).code);
// lastError=0 是「失败但没置错误码」，与映射表里的 "no error reported" 不是一回事。
const zeroError = describeLastError(0);
check("the SDK error map holds no 0 entry", !sdk.EVERYTHING_ERROR_CODES.has(0) && sdk.EVERYTHING_ERROR_CODES.size === 9, `size ${sdk.EVERYTHING_ERROR_CODES.size}, has(0) ${sdk.EVERYTHING_ERROR_CODES.has(0)}`);
// 6：错误码表与源码字面量互校——lib/ 里新出现一个 code 却没进 README 就红。
const codeTick = String.fromCharCode(96);
const readmeForCodeScan = readRepoFile("README.md");
const sourceCodes = [...new Set(["lib/index.js", "lib/components/everything/index.js", "lib/components/everything/sdk.mjs"].flatMap((relative) => [...readRepoFile(relative).matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)].map((match) => match[1])))];
// AnyTxt 侧单开一把只认 ANYTXT_ 前缀的扫描：整文件并进上面那条扁平正则会把
// `lib/components/anytxt/anytxt.mjs:258` 的 `method: "POST"` 也算成错误码（[A-Z][A-Z0-9_]{3,} 正好命中），
// 于是 README 被逼着登记 POST。清单只该装错误码，所以按前缀收窄，不放宽文档。
const anytxtCodes = [...new Set([...readRepoFile("lib/components/anytxt/anytxt.mjs").matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)].map((match) => match[1]).filter((code) => code.startsWith("ANYTXT_")))];
const allCodes = [...new Set([...sourceCodes, ...anytxtCodes])];
const undocumentedCodes = allCodes.filter((code) => !readmeForCodeScan.includes(codeTick + code + codeTick));
check("every code literal in lib/ is documented in README", undocumentedCodes.length === 0, undocumentedCodes.length === 0 ? `${allCodes.length} codes documented (${anytxtCodes.length} ANYTXT_)` : `undocumented: ${undocumentedCodes.join(", ")}`);
check("lastError 0 gets its own not-ready text", zeroError.code === "EVERYTHING_ERROR_0" && /index is not ready/.test(zeroError.message) && !/no error reported/.test(zeroError.message), zeroError.message);

const spacedScope = "C:\\Program Files";
check("a search alone stays bare", buildSearch({ search: "*.dll" }) === "*.dll");
// 契约（P0-3）：path: 的 scope 一律先规范化分隔符、补尾分隔符再加引号，Everything
// 才会匹配目录内容而不是目录名本身，所以这里的期望值带尾反斜杠。这条断言随契约
// 改过，不是为了让测试变绿。
check("a scope with spaces is quoted", buildSearch({ search: "ext:dll", path: spacedScope }) === `ext:dll path:"${spacedScope}\\"`, buildSearch({ search: "ext:dll", path: spacedScope }));
check("default exclusions render as !path:", buildSearch({ search: "*.md" }, parseExclude(void 0)) === "*.md !path:$RECYCLE.BIN !path:\"System Volume Information\" !path:WinSxS", buildSearch({ search: "*.md" }, parseExclude(void 0)));
check("exclude:\"\" disables exclusions", buildSearch({ search: "*.md" }, parseExclude("")) === "*.md");
let missingScopeThrew = false;
try {
	buildSearch({ search: "*.dll", path: "C:\\definitely missing dir 42" });
} catch (error) {
	missingScopeThrew = /does not exist/.test(error.message);
}
check("a missing scope path throws", missingScopeThrew);
// 0.4.6-1：诊断写全——消息要带最近存在的父目录与三条出路，模型据此能自己改对。
let missingScopeMessage = "";
try {
	buildSearch({ search: "*.dll", path: "C:\\definitely missing dir 42" });
} catch (error) {
	missingScopeMessage = error.message;
}
// 0.4.6-1 的三条出路里，通配 scope 那条已被实测推翻：`path:C:\x\*` 回 0 条、`path:C:\x`
// 回 19 条，所以文案不再推荐它，断言也跟着改成「不许出现」。推荐的必须是一条真能走通的路。
check("a missing scope names the nearest existing parent and the ways out", /nearest existing parent: C:\\/.test(missingScopeMessage) && !/wildcard scope/.test(missingScopeMessage) && /omit path:/.test(missingScopeMessage) && /pathMustExist: false/.test(missingScopeMessage), missingScopeMessage);
// pathMustExist:false 才降级：scope 被丢掉、整盘照搜，并由 notes 回报、结果头明写。
const ignoreNotes = {};
// 全盘回退要两次确认：`pathMustExist: false` 单独出现是参数错误（下面第二条断言），
// 只有再加 `allDrives: true` 才真的丢掉 scope。漏路径就丢 scope 等于搜整个索引，实测 22541 条。
const ignoredScopeSearch = buildSearch({ search: "*.dll", path: "C:\\definitely missing dir 42", pathMustExist: false, allDrives: true }, [], ignoreNotes);
check("pathMustExist:false with allDrives:true drops the scope instead of throwing", ignoredScopeSearch === "*.dll" && ignoreNotes.ignoredScope === "C:\\definitely missing dir 42", `${ignoredScopeSearch} / ${ignoreNotes.ignoredScope}`);
let halfConfirmedError;
try {
	buildSearch({ search: "*.dll", path: "C:\\definitely missing dir 42", pathMustExist: false });
} catch (error) {
	halfConfirmedError = error;
}
check("a missing scope with pathMustExist:false alone is rejected, naming allDrives", halfConfirmedError instanceof Error && /allDrives: true/.test(halfConfirmedError.message) && /whole-index fallback/.test(halfConfirmedError.message) && /nearest existing parent: C:\\/.test(halfConfirmedError.message), halfConfirmedError === void 0 ? "no error thrown" : halfConfirmedError.message);
let allDrivesAloneError;
try {
	await compiledTool.execute({ search: "*.dll", allDrives: true }, { signal: new AbortController().signal });
} catch (error) {
	allDrivesAloneError = error;
}
check("allDrives without pathMustExist:false is rejected instead of doing nothing", allDrivesAloneError instanceof Error && /allDrives only authorises the whole-index fallback/.test(allDrivesAloneError.message), allDrivesAloneError === void 0 ? "no error thrown" : allDrivesAloneError.message);
const ignoredScopeHeader = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: true, pathIgnored: "C:\\definitely missing dir 42" }).split("\n")[0];
check("the header says a dropped path was ignored", /path ignored: does not exist/.test(ignoredScopeHeader), ignoredScopeHeader);
// 0.4.7-2：type 渲染成 Everything 自己的 file:/folder:（零新 SDK 绑定，实测
// node_modules folder: 393 / file: 2 对着全量 33307）。串里已带 file:/folder: 时不重复
// 追加——两个词 AND 成 0 条，静默归零最贵，所以「没追加」做成值字段并上结果头。
const fileTypeSearch = buildSearch({ search: "*.dll", type: "file" });
const dirTypeSearch = buildSearch({ search: "*.dll", type: "dir" });
check("type renders as Everything's own file:/folder: terms", fileTypeSearch === "*.dll file:" && dirTypeSearch === "*.dll folder:", `${fileTypeSearch} | ${dirTypeSearch}`);
const typeNotes = {};
const conflictingTypeSearch = buildSearch({ search: "node_modules folder:", type: "file" }, [], typeNotes);
const conflictingTypeHeader = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: true, typeIgnored: typeNotes.skippedType }).split("\n")[0];
check("type is not re-appended when the search already filters", conflictingTypeSearch === "node_modules folder:" && typeNotes.skippedType === "file" && /type not appended/.test(conflictingTypeHeader), `${conflictingTypeSearch} / ${typeNotes.skippedType} / ${conflictingTypeHeader}`);
// 一档第 1 条：带通配的 scope 不许被存在性检查误杀（`D:` 盘在不在都不是参数错误）。
// 同时尾部通配要被折叠：实测 `path:C:\x\*` 回 0 条、`path:C:\x` 回 19 条——Everything
// 的 `path:` 本来就是前缀匹配、已含全部子目录，尾部 `*` 只会把 scope 变成匹配不到的字符串。
const wildcardScope = buildSearch({ search: "*.dll", path: "D:/code/*" });
check("a wildcard scope is not stat-ed away and its trailing wildcard is collapsed", wildcardScope === "*.dll path:D:\\code\\", wildcardScope);
let wildcardWithSpaces = "";
try {
	wildcardWithSpaces = buildSearch({ search: "*.dll", path: "C:/Program Files/*" });
} catch (error) {
	wildcardWithSpaces = `${error.message}`;
}
// 带空格的通配 scope：既要不报错、要加引号，尾部通配也要被折叠（`C:\x\*` 与 `C:\x\` 同义，
// 前者实测回 0 条）。期望值随新契约改，不是为了让测试变绿。
check("a wildcard scope with spaces stays quoted and loses its trailing wildcard", wildcardWithSpaces === "*.dll path:\"C:\\Program Files\\\"", wildcardWithSpaces);
// scope 指向文件：实测 `*.md` + path=真实 .md 文件恒为 0 命中，且旧输出一句提示都没有
// （给文件补了尾分隔符）。path 只收目录，所以这里必须是显式参数错误、并给出两条出路。
// 样本用 process.execPath：绝对路径、必然存在、必然是文件，不硬编码仓库位置。
let fileScopeError;
try {
	buildSearch({ search: "*.dll", path: process.execPath });
} catch (error) {
	fileScopeError = error;
}
check("a file path as scope is rejected, naming the directory-only rule and both ways out", fileScopeError instanceof Error && /path must be a directory, not a file/.test(fileScopeError.message) && /parent directory/.test(fileScopeError.message) && /ext:/.test(fileScopeError.message), fileScopeError === void 0 ? "no error thrown" : fileScopeError.message);
// 通配 scope 不走这条校验：通配串没有可 stat 的对象，误杀会把合法写法变成参数错误。
let wildcardFileLikeThrew = "";
try {
	wildcardFileLikeThrew = buildSearch({ search: "*.dll", path: "C:/Program Files/*" });
} catch (error) {
	wildcardFileLikeThrew = `THREW: ${error.message}`;
}
check("a wildcard scope is never stat-ed by the file check", !wildcardFileLikeThrew.startsWith("THREW:"), wildcardFileLikeThrew);

const truncatedHeader = formatOutput({
	items: [{ path: "C:\\a.txt", folder: false, size: 10 }],
	total: 9,
	truncated: true,
	nextOffset: 1,
	dbLoaded: true,
	excluded: 3
}).split("\n")[0];
check("header reports page offset and applied exclusions", /Found 1 of 9 results \(offset 0\)/.test(truncatedHeader) && /3 exclusion rules applied/.test(truncatedHeader), truncatedHeader);
const unloadedHeader = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: false, excluded: 0 }).split("\n")[0];
check("header flags an unloaded index", /index is not loaded yet/.test(unloadedHeader), unloadedHeader);
// 0.4.6-4：采样写进结构——非 countOnly 在 Found 行下面固定一行 shown/total/nextOffset，
// 末页 nextOffset 打 `-`。这条防的是「把一堆 30 条采样当全量」那类误读。
const statsLines = formatOutput({
	items: Array.from({ length: 5 }, (_unused, index) => ({ path: `C:\\f${index}.txt`, folder: false, size: 10, mtime: -1 })),
	total: 50,
	truncated: true,
	nextOffset: 5,
	offset: 0,
	dbLoaded: true
}).split("\n");
check("the header carries shown/total/nextOffset", statsLines[1] === "shown 5 / total 50 / nextOffset 5", statsLines.slice(0, 2).join(" | "));
const lastPageText = formatOutput({ items: [{ path: "C:\\a.txt", folder: false, size: 1, mtime: -1 }], total: 1, truncated: false, dbLoaded: true });
check("a last page prints a dash for nextOffset", /^shown 1 \/ total 1 \/ nextOffset -$/m.test(lastPageText), lastPageText.split("\n")[1]);
// 空页（offset 越过 total）不许印成全量：total 大于 0 而这一页为空时，`Found 0 of 15 results`
// 会被读成「这个范围里什么都没有」，读的人不会再往里翻。实测 offset:100 / total:15 就是这样，
// 旧输出一句提示都没有。
const pastEndText = formatOutput({ items: [], total: 15, truncated: false, offset: 100, dbLoaded: true });
check("an empty page past the end names the overshoot", /offset 100 is past the end/.test(pastEndText) && /total is 15/.test(pastEndText), pastEndText.split("\n")[0]);
// 显示层契约：countOnly 的 header 只报数，不进 offset 分支（旧版冒出「pass offset 0」）。
const countOnlyText = formatOutput({
	items: [],
	total: 15712,
	truncated: false,
	offset: 0,
	countOnly: true,
	dbLoaded: true,
	excluded: 0
});
check("countOnly prints a count, not an offset page", countOnlyText.split("\n")[0] === "Found 15712 matches (count only)" && !/pass offset/.test(countOnlyText) && /list the paths/.test(countOnlyText) && !/shown /.test(countOnlyText), countOnlyText.split("\n")[0]);
// 搬输出：红线从工具 description 搬到运行时输出，每条都要有看守。A1–A5 逐条对应门控，
// 尾追加一律不会碰到上面钉 shown 行或 countOnly 首行的那几条精确等值。
//
// 0 命中有两组注记——头行的边界尾注、页脚的「放宽」出路——它们共用同一组门控，所以
// 守门也必须共用一把尺子。旧写法把守卫写成 `!/not in index/`：措辞一改，正则再也匹配
// 不到任何东西，「该不出现时必须不出现」就静默失效（测试照样绿，但已经不管事）。
const hasZeroAnnotation = (text) => /no match in the index/.test(text) || /widen:/.test(text);
const zeroLoadedText = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: true });
check("a zero-hit first line names the index boundary without the word missing", zeroLoadedText.split("\n")[0] === "Found 0 results = no match in the index (indexed volumes only)" && !/missing/i.test(zeroLoadedText), zeroLoadedText.split("\n")[0]);
const zeroCountOnlyText = formatOutput({ items: [], total: 0, truncated: false, countOnly: true, dbLoaded: true });
check("countOnly carries neither the boundary tail nor the widen footer", zeroCountOnlyText.split("\n")[0] === "Found 0 matches (count only)" && !hasZeroAnnotation(zeroCountOnlyText), zeroCountOnlyText.split("\n")[0]);
const zeroUnloadedText = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: false });
check("an unloaded index points at everything_status instead of concluding", /→ call everything_status/.test(zeroUnloadedText.split("\n")[0]) && !hasZeroAnnotation(zeroUnloadedText), zeroUnloadedText.split("\n")[0]);
const zeroScopedText = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: true, pathIgnored: "C:\\missing-42" });
const zeroTypedText = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: true, typeIgnored: "file" });
check("a rewritten scope keeps both zero-hit annotations off", !hasZeroAnnotation(zeroScopedText) && !hasZeroAnnotation(zeroTypedText), `${zeroScopedText.split("\n")[0]} | ${zeroTypedText.split("\n")[0]}`);
// 0 命中必须有下一步：与截断页脚的 narrow 对称，给一条「放宽」的出路。排除规则是零命中的
// 一个常见成因，而且条数已经写在头行，所以当次生效时把 exclude:"" 一并给出。
const zeroWithExclusions = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: true, excluded: 3 });
const zeroWithoutExclusions = formatOutput({ items: [], total: 0, truncated: false, dbLoaded: true, excluded: 0 });
check("a zero-hit page offers a way to widen, symmetric with the truncation footer", /widen: drop path:, drop ext:, or relax the pattern/.test(zeroWithExclusions) && /widen:/.test(zeroWithoutExclusions), zeroWithExclusions.split("\n").pop());
check("the widen footer names the exclude escape only when exclusion rules were in force", /exclude:""/.test(zeroWithExclusions) && !/exclude:""/.test(zeroWithoutExclusions), JSON.stringify([zeroWithExclusions.split("\n").pop(), zeroWithoutExclusions.split("\n").pop()]));
const noNextOffsetFooter = formatOutput({ items: [{ path: "C:\\a.txt", folder: false, size: 1, mtime: -1 }], total: 9, truncated: true, offset: 0, dbLoaded: true });
check("a truncated page without nextOffset still pages by offset, never by maxResults", /pass offset \d/.test(noNextOffsetFooter) && !/raise maxResults/.test(noNextOffsetFooter) && !/Showing the first/.test(noNextOffsetFooter), noNextOffsetFooter.split("\n").pop());
check("the dead 'Showing the first' footer is gone from the formatter", !/Showing the first/.test(readRepoFile("lib/shared/format.mjs")), "lib/shared/format.mjs carries no 'Showing the first' footer");
// `<DIR>` 的解释搬到它出现的现场：只在本次结果真有目录项时，末行单起一句。门控不严就会
// 变成每条结果都挂一句无用提示，所以纯文件结果这条必须显式否认。
const folderHintOut = formatOutput({
	items: [{ path: "C:\\dir", folder: true, size: -1, mtime: -1 }, { path: "C:\\a.txt", folder: false, size: 10, mtime: -1 }],
	total: 2,
	truncated: false,
	dbLoaded: true
});
check("a result carrying a folder explains <DIR> on its last line", folderHintOut.split("\n").pop() === "(<DIR> is a folder, never read it.)", folderHintOut.split("\n").pop());
const filesOnlyOut = formatOutput({ items: [{ path: "C:\\a.txt", folder: false, size: 10, mtime: -1 }], total: 1, truncated: false, dbLoaded: true });
check("a files-only result carries no <DIR> hint", !/<DIR> is a folder/.test(filesOnlyOut), filesOnlyOut.split("\n").pop());
// 显示层契约：mtime 读不到打 -，不许把 -1 印成 1970；读得到就是固定宽度的本地时间。
const noTimeItem = formatItem({ path: "C:\\a.txt", folder: false, size: 10, mtime: -1 });
const hasTimeItem = formatItem({ path: "C:\\a.txt", folder: false, size: 10, mtime: Date.UTC(2026, 0, 2, 3, 4, 5) });
check("a missing mtime prints a dash, never 1970", /\t-\s*$/.test(noTimeItem) && !/1970/.test(noTimeItem), JSON.stringify(noTimeItem));
check("a real mtime prints a fixed-width local time", /\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(hasTimeItem), JSON.stringify(hasTimeItem));
// 9：size 与 mtime 都缺时三列仍恒在，缺值打 `-`，不留连着的 TAB。
const noSizeNoTimeItem = formatItem({ path: "C:\\a.txt", folder: false, size: -1, mtime: -1 });
const bareColumns = noSizeNoTimeItem.split("\t");
check("a missing size keeps three columns and prints a dash", bareColumns.length === 3 && bareColumns[1] === "-" && bareColumns[2].startsWith("-") && !/\t\t/.test(noSizeNoTimeItem), JSON.stringify(noSizeNoTimeItem));
// 显示层契约：sort 缺省 + descending:true 就是 name 降序（README 曾写「忽略」，代码对、文档错）。
// README 开发者备注里那批实测常量，抽成可执行真值表：常量被改了、README 写错了，
// 这里先红。四个数都是在本机用 native/Everything64.dll 现测的，不是抄 SDK 文档。
const MEASURED_SDK_CONSTANTS = [
	["SORT_VALUES name", sdk.SORT_VALUES.get("name"), 1],
	["SORT_VALUES path", sdk.SORT_VALUES.get("path"), 3],
	["SORT_VALUES size", sdk.SORT_VALUES.get("size"), 5],
	["SORT_VALUES dateModified", sdk.SORT_VALUES.get("dateModified"), 13],
	["SORT_VALUES dateCreated", sdk.SORT_VALUES.get("dateCreated"), 15],
	["SORT_DESCENDING_OFFSET (+1, not +100)", sdk.SORT_DESCENDING_OFFSET, 1],
	["REQUEST_FLAG_FULL_PATH (without it every path reads back empty)", sdk.REQUEST_FLAG_FULL_PATH, 4],
	["REQUEST_FLAG_SIZE", sdk.REQUEST_FLAG_SIZE, 16],
	["REQUEST_FLAG_DATE_MODIFIED", sdk.REQUEST_FLAG_DATE_MODIFIED, 64],
	["FILETIME_EPOCH_OFFSET_MS", sdk.FILETIME_EPOCH_OFFSET_MS, 11644473600000]
];
for (const [label, actual, measured] of MEASURED_SDK_CONSTANTS) check(`measured SDK constant ${label}`, actual === measured, `expected ${measured}, got ${actual}`);
const allFlags = sdk.REQUEST_FLAG_FULL_PATH | sdk.REQUEST_FLAG_SIZE | sdk.REQUEST_FLAG_DATE_MODIFIED;
check("the three request flags together are 84", allFlags === 84, String(allFlags));
// 文档互校：README 的开发者备注必须写着同一批数，改代码不更文档也会红。
const readmeSource = readRepoFile("README.md");
check("README's measured-constant section still carries all four numbers", readmeSource.includes("降序 = 升序 +1") && readmeSource.includes("FULL_PATH = 4") && readmeSource.includes("SIZE = 16") && readmeSource.includes("DATE_MODIFIED = 64") && readmeSource.includes("84"), "README carries 降序 +1 / FULL_PATH 4 / SIZE 16 / DATE_MODIFIED 64 / 84");

const bareDesc = sdk.sortValueFor(void 0, true);
const bareAsc = sdk.sortValueFor(void 0, false);
// 期望值写字面量（实测 1 / 2），不再把实现抄一遍：原来用
// `SORT_VALUES.get("name") + SORT_DESCENDING_OFFSET` 当期望，实现与期望一起漂也照样全绿。
check("bare descending means name descending (measured: 1 asc, 2 desc)", bareAsc === 1 && bareDesc === 2, `bare ascending ${bareAsc}, bare descending ${bareDesc}`);

// --- live searches (skipped when Everything is not running) ---
const exec = { signal: new AbortController().signal };
const base = { maxResults: 5, timeoutMs: SEARCH_TIMEOUT_MS, offset: 0, exclude: parseExclude(void 0) };

let everythingRunning = true;
try {
	await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 1, exclude: [] });
} catch (error) {
	if (error?.code === "EVERYTHING_NOT_RUNNING") everythingRunning = false;
	else fail("Everything reachable", `${error?.code ?? error?.name}: ${error?.message}`);
}

// 任务返回值以 "inconclusive" 开头 = 这条用例没拿到证据（例如本机 1ms 计时基准不成立）。
// 旧写法把返回值直接交给 pass()，于是「没测出证据也算通过」；现在记为 SKIP，而
// VERIFY_REQUIRE_LIVE=1 时 SKIP 计为失败——没有证据的用例不许再冒充绿灯。
const live = async (name, task) => {
	if (!everythingRunning) return skip(name, "Everything is not running");
	let detail;
	try {
		detail = await task();
	} catch (error) {
		fail(name, `${error?.code ?? error?.name}: ${error?.message}`);
		return;
	}
	if (typeof detail === "string" && detail.startsWith("inconclusive")) return skip(name, detail);
	pass(name, detail);
};

// 两条组件行在这里先加载：外壳自 3d 起不再代注册，行相关的用例一律走行句柄。
const faceModule = {
	everything: await import(pathToFileURL(path.join(repoRoot, "lib", "components", "everything", "index.js")).href),
	anytxt: await import(pathToFileURL(path.join(repoRoot, "lib", "components", "anytxt", "index.js")).href)
};

await live("a quoted scope with spaces matches by magnitude, not by a term split", async () => {
	const found = await runQuery(exec, { search: "ext:dll", path: spacedScope }, { ...base, exclude: [] });
	// The unquoted form split `path:C:/Program Files` into `path:C:/Program` plus a
	// `Files` keyword and returned 21 stray hits — non-empty and wrong, which is
	// worse than zero. The default order is name ascending, so assert the magnitude
	// plus that every retained path really sits inside the scope, never a single
	// first result.
	assert.ok(found.total >= 1000, `total was ${found.total}; the unquoted term-split baseline was 21`);
	const outside = found.items.filter((item) => !item.path.toLowerCase().startsWith("c:\\program files\\"));
	assert.equal(outside.length, 0, `results outside the scope: ${outside.map((item) => item.path).join(", ")}`);
	return `total ${found.total}, all ${found.items.length} retained inside the scope`;
});

await live("page 2 does not overlap page 1", async () => {
	const page1 = await runQuery(exec, { search: "*.dll", path: "C:\\Windows\\System32" }, { ...base, exclude: [] });
	const page2 = await runQuery(exec, { search: "*.dll", path: "C:\\Windows\\System32" }, { ...base, exclude: [], offset: 5 });
	assert.equal(page1.nextOffset, 5);
	assert.equal(page2.items.filter((item) => page1.items.some((other) => other.path === item.path)).length, 0, "pages overlap");
	return `next ${page1.nextOffset}, page2 ${page2.items.length}`;
});

// 一档第 2 条：offset 上界必须钳住。实测 `offset: 4294967296` 会静默回绕到第 0 页，
// 调用方以为翻到了新页、其实拿回第一页；`1e12` 则把原始入参回显进 value.offset，
// 页脚的「pass offset N」跟着骗人。界内行为（空页、负数钳 0、小数取整）一行不动。
await live("an out-of-range offset clamps instead of wrapping to page 0", async () => {
	const page0 = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 3, exclude: [], offset: 0 });
	const wrapped = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 3, exclude: [], offset: 4294967296 });
	const huge = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 3, exclude: [], offset: 1e12 });
	const negative = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 3, exclude: [], offset: -5 });
	const fractional = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 3, exclude: [], offset: 1.9 });
	assert.equal(wrapped.items.length, 0, `2^32 must be an empty page, got ${wrapped.items.length} item(s)`);
	assert.equal(wrapped.truncated, false);
	assert.equal(wrapped.offset, OFFSET_CAP, `value.offset echoed ${wrapped.offset} for 2^32`);
	assert.equal(huge.offset, OFFSET_CAP, `value.offset echoed ${huge.offset} for 1e12`);
	const overlap = wrapped.items.filter((item) => page0.items.some((other) => other.path === item.path));
	assert.equal(overlap.length, 0, "the clamped page overlaps page 0: SetOffset still wrapped");
	assert.equal(negative.offset, 0, "a negative offset must still clamp to 0");
	assert.equal(fractional.offset, 1, "a fractional offset must still floor to 1");
	return `2^32 and 1e12 -> offset ${wrapped.offset}, 0 items, no overlap with page 0`;
});

await live("default exclusions cut the total", async () => {
	const quiet = await runQuery(exec, { search: "*.md" }, base);
	const raw = await runQuery(exec, { search: "*.md" }, { ...base, exclude: parseExclude("") });
	assert.ok(raw.total > quiet.total, `unfiltered ${raw.total} is not greater than filtered ${quiet.total}`);
	assert.equal(quiet.excluded, 3);
	return `*.md ${raw.total} -> ${quiet.total} with 3 rules`;
});

await live("dbLoaded is a boolean on a live result", async () => {
	const found = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 1, exclude: [] });
	assert.equal(typeof found.dbLoaded, "boolean");
	return `dbLoaded ${found.dbLoaded}`;
});

// 0.3.0 契约：size 与 mtime 各自的 request flag 都要成对设，漏一个读回来是 -1 或 0。
await live("size and mtime stay paired with their request flags", async () => {
	const found = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 5, exclude: [] });
	const unread = found.items.filter((item) => !(item.size >= 0) || !(item.mtime > 0));
	assert.equal(unread.length, 0, `size/mtime read back empty for ${unread.length} item(s)`);
	return `${found.items.length} items carry size and mtime`;
});

// 0.4.10：返回体本身必须能无损 JSON 往返。0.4.9 的 96 条全绿，活跑却报
// `invalid output: value is not lossless JSON`——套件里没有一条钉返回体，这就是漏网的根。
// 分数毫秒、超 2^53 的 size、值为 undefined 的键，JSON 一过就变样，所以逐字段查，不只看一次深比对。
await live("a live result survives a lossless JSON round-trip", async () => {
	const nativeScope = path.join(repoRoot, "native");
	const value = await runQuery(exec, { search: "*.dll", path: nativeScope, type: "file" }, { ...base, maxResults: 3, exclude: [] });
	const text = JSON.stringify(value);
	assert.equal(JSON.stringify(JSON.parse(text)), text, "the value is not lossless JSON");
	for (const key of ["total", "offset"]) assert.ok(Number.isFinite(value[key]), `${key} is not finite: ${value[key]}`);
	for (const item of value.items) {
		assert.ok(Number.isFinite(item.size) && Number.isSafeInteger(item.size), `size is not a safe integer: ${item.size}`);
		assert.ok(Number.isFinite(item.mtime) && Number.isSafeInteger(item.mtime), `mtime is not integer milliseconds: ${item.mtime}`);
		assert.ok(!Object.is(item.size, -0) && !Object.is(item.mtime, -0), "a numeric field came back as -0");
	}
	const undefinedKeys = Object.entries(value).filter(([, field]) => field === void 0).map(([key]) => key);
	assert.equal(undefinedKeys.length, 0, `the value carries undefined key(s): ${undefinedKeys.join(", ")}`);
	return `lossless JSON over ${value.items.length} item(s), mtime integer ms`;
});

// 0.4.7-4：type 的 live 验收。基准实测：node_modules folder: 393 条目录、file: 2 条文件，
// 两个数都远小于无过滤全量——`*.dll file:` 前后同数不算证据（树上没有名叫 *.dll 的目录，
// file: 本来就无事可做）。回包的 folder 布尔与 IsFolderResult 同源，所以 dir 必须全 true、
// file 必须全 false；type 叠加 countOnly 只是搜索词，分页语义一行不动、总数照旧。
await live("type narrows by kind and agrees with the folder flag", async () => {
	const all = await runQuery(exec, { search: "node_modules" }, { ...base, maxResults: 50, exclude: [] });
	const dirs = await runQuery(exec, { search: "node_modules", type: "dir" }, { ...base, maxResults: 5, exclude: [] });
	const files = await runQuery(exec, { search: "node_modules", type: "file" }, { ...base, maxResults: 5, exclude: [] });
	assert.ok(dirs.total > 0, `dir: matched nothing`);
	assert.ok(all.total > dirs.total, `the kind filter did not narrow: all ${all.total} vs dir ${dirs.total}`);
	assert.equal(dirs.items.filter((item) => item.folder !== true).length, 0, "dir: returned a file");
	assert.equal(files.items.filter((item) => item.folder !== false).length, 0, "file: returned a folder");
	const counted = await runQuery(exec, { search: "node_modules", type: "dir" }, { ...base, maxResults: 5, exclude: [], countOnly: true });
	assert.equal(counted.items.length, 0, "type + countOnly must not decode items");
	assert.equal(counted.total, dirs.total, "type + countOnly changed the total");
	return `dir ${dirs.total}, file ${files.total}, all ${all.total}; type + countOnly ${counted.total}`;
});

// 0.3.0 契约：name 升序的尾部与 name 降序的头部必须互为反序，SORT 偏移才算实测钉死。
await live("name ascending and descending are exact reverses", async () => {
	const sortBase = { ...base, maxResults: 5, exclude: [], sort: "name", descending: false };
	const asc = await runQuery(exec, { search: "*.dll" }, sortBase);
	const desc = await runQuery(exec, { search: "*.dll" }, { ...sortBase, descending: true });
	const tail = await runQuery(exec, { search: "*.dll" }, { ...sortBase, offset: Math.max(0, asc.total - asc.items.length) });
	const tailPaths = tail.items.map((item) => item.path);
	const descHead = desc.items.map((item) => item.path).slice(0, tailPaths.length).reverse();
	assert.deepEqual(descHead, tailPaths, "the descending head is not the reverse of the ascending tail");
	return `ascending tail and descending head agree over ${asc.total} matches`;
});

// 0.3.0 契约：countOnly 只报数，items 空、不解码。
await live("countOnly counts without decoding items", async () => {
	const found = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 5, exclude: [], countOnly: true });
	assert.equal(found.items.length, 0);
	assert.ok(found.total > 0, `total was ${found.total}`);
	// 0.4.1：countOnly 不许报截断，否则页脚会让人去翻第 0 页。
	assert.equal(found.truncated, false, "countOnly must not report truncation");
	assert.equal(found.nextOffset, void 0, "countOnly must not report nextOffset");
	return `total ${found.total}, items 0, not truncated`;
});

// P2 契约：事件循环不被查询阻塞——这是 P2 的真正收益，必须有例。
// 判法要经得起复跑，所以先做对照、再挑一个真正慢的查询：
//  1) 对照：纯空闲 10ms 下 1ms interval 必须真的累加，否则这套计时在本机不可用，
//     这条只能记 inconclusive，不假装通过。
//  2) 慢查询 `regex:.*` 实测 ~30ms，而 `*` 宽通配只有 ~6ms：拿 5ms 定时器和 6ms 的
//     查询抢跑是在测调度抖动，30ms 对 5ms 有 6 倍余量才是判定阻塞的余量。
await live("the event loop stays free while a query runs", async () => {
	let control = 0;
	const controlTicker = setInterval(() => {
		control += 1;
	}, 1);
	await new Promise((resolve) => setTimeout(resolve, 10));
	clearInterval(controlTicker);
	if (control === 0) return "inconclusive: a 1 ms interval does not tick even while idle here";
	const startedAt = Date.now();
	const query = runQuery(exec, { search: "regex:.*" }, { ...base, maxResults: 500, exclude: [] });
	const timer = new Promise((resolve) => setTimeout(() => resolve("timer"), 5));
	const winner = await Promise.race([timer, query.then(() => "query", () => "query")]);
	const found = await query;
	const elapsed = Date.now() - startedAt;
	if (winner === "timer") return `the 5 ms timer won against a ${elapsed}ms query: the main thread stayed free while it was in flight`;
	if (elapsed < 5) return `inconclusive: the query returned in ${elapsed}ms, before a 5 ms timer could judge it`;
	assert.fail(`a ${elapsed}ms query beat the 5 ms timer: the main thread was blocked by the native call`);
});

// P2 契约：abort 之后是 SEARCH_ABORTED，且下一次查询照常（worker 已换新）。
// 先丢掉当前 worker：下一次请求得重新起线程、载 koffi 与 DLL，请求确实在途，
// 2ms 的 abort 才不是和一条已经回来的回复抢跑（实测查询本体只有 6ms 左右）。
await live("an abort mid-flight -> SEARCH_ABORTED and the next query still works", async () => {
	replaceWorker();
	const controller = new AbortController();
	const pending = runQuery({ signal: controller.signal }, { search: "*" }, { ...base, maxResults: 500, exclude: [] });
	setTimeout(() => controller.abort(), 2);
	let aborted;
	try {
		await pending;
	} catch (error) {
		aborted = error;
	}
	assert.equal(aborted?.code, "SEARCH_ABORTED", `expected SEARCH_ABORTED, got ${aborted?.code ?? "a result"}`);
	const next = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 5, exclude: [] });
	assert.ok(next.items.length > 0, "the query after the abort returned nothing");
	return `SEARCH_ABORTED, then ${next.items.length} items from the fresh worker`;
});

// 2a 契约：apply()/HMR 重载只 settle 本行在途请求，不再跨行互相打断。
// 先 replace 让这次查询得重新起线程（光启动就要 30 ms 上下），确定它还在途
// 再重挂；旧实现只丢引用，这条请求会一直等下去，100 ms 内拿不到任何结果。
const fakeRow = (label) => {
	const registered = new Map();
	const sections = [];
	return {
		label,
		registered,
		sections,
		ctx: {
			tools: {
				register(tool) {
					registered.set(tool.name, tool);
				}
			},
			systemPrompt: {
				section(section) {
					sections.push(section);
				}
			},
			logger: { warn() {} }
		}
	};
};
const rowA = fakeRow("A");
const rowB = fakeRow("B");
const ROW_CONFIG = { maxResults: 100, timeoutMs: SEARCH_TIMEOUT_MS };

await live("an apply() reload settles only its own row's in-flight request", async () => {
	await faceModule.everything.apply(rowA.ctx, ROW_CONFIG);
	assert.equal(rowA.registered.size, 2, `row A registered ${rowA.registered.size} tools: ${[...rowA.registered.keys()].join(",")}`);
	const firstRuntime = runtimeFor(rowA.ctx);
	firstRuntime.replace();
	const pending = firstRuntime.runQuery(exec, { search: "regex:.*" }, { ...base, maxResults: 500, exclude: [] });
	const settled = pending.then((found) => ({ resolved: found }), (error) => ({ code: error?.code, message: error?.message }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await faceModule.everything.apply(rowA.ctx, ROW_CONFIG);
	const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 100))]);
	assert.equal(outcome.code, "EVERYTHING_WORKER_REPLACED", `the in-flight request did not reject as replaced: ${JSON.stringify(outcome).slice(0, 160)}`);
	assert.notEqual(runtimeFor(rowA.ctx), firstRuntime, "a reload must register a fresh runtime instead of reusing the old object");
	const after = await runtimeFor(rowA.ctx).runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 5, exclude: [] });
	assert.ok(after.items.length > 0, "the query after the reload returned nothing");
	return `EVERYTHING_WORKER_REPLACED, then ${after.items.length} items from the fresh worker`;
});

// 2a 的目的本身：A 行在途时重挂 B 行，A 的请求必须原样跑完，不许被 settle。
await live("another row's apply() leaves an in-flight request alone", async () => {
	await faceModule.everything.apply(rowB.ctx, ROW_CONFIG);
	assert.equal(rowB.registered.size, 2, `row B registered ${rowB.registered.size} tools: ${[...rowB.registered.keys()].join(",")}`);
	const rowRuntime = runtimeFor(rowA.ctx);
	assert.notEqual(runtimeFor(rowB.ctx), rowRuntime, "two rows must not share one runtime");
	// 串行基线照 :836-846 五并发那套构造法：同参数先串行跑一遍，再拿来逐条比，不自造宽松比较。
	const serialPaths = (await rowRuntime.runQuery(exec, { search: "regex:.*" }, { ...base, maxResults: 500, exclude: [] })).items.map((item) => item.path);
	rowRuntime.replace();
	const pending = rowRuntime.runQuery(exec, { search: "regex:.*" }, { ...base, maxResults: 500, exclude: [] });
	const settled = pending.then((found) => ({ resolved: found }), (error) => ({ code: error?.code, message: error?.message }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	await faceModule.everything.apply(rowB.ctx, ROW_CONFIG);
	const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 150))]);
	assert.ok(outcome.resolved !== void 0, `row B's reload touched row A's in-flight request: ${JSON.stringify(outcome).slice(0, 160)}`);
	assert.equal(outcome.code, void 0, `row A's request was settled with ${outcome.code}`);
	assert.deepEqual(outcome.resolved.items.map((item) => item.path), serialPaths, "row A's items differ from the serial baseline taken before row B reloaded");
	return `row A kept all ${outcome.resolved.items.length} items, identical to the serial baseline, while row B reloaded`;
});

// 2a-t 第 5 步①：A 在途时先 abort A、紧接着重挂 B 行。顺序固定先 abort 再重挂，
// 且 abort 的落定必须在重挂之前就已发生——否则「重载导致取消」会冒充 abort，两码互换。
await live("aborting row A before reloading row B keeps row A's code SEARCH_ABORTED", async () => {
	const rowRuntime = runtimeFor(rowA.ctx);
	const rowBRuntime = runtimeFor(rowB.ctx);
	assert.notEqual(rowBRuntime, rowRuntime, "two rows must not share one runtime");
	rowRuntime.replace();
	const controller = new AbortController();
	const pending = rowRuntime.runQuery({ signal: controller.signal }, { search: "regex:.*" }, { ...base, maxResults: 500, exclude: [] });
	const settled = pending.then((found) => ({ resolved: found }), (error) => ({ code: error?.code, message: error?.message }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	// 这一段的落定只可能来自 abort 本身：重挂 B 还没发生，先把它钉住。
	const afterAbort = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve({ notSettledYet: true }), 100))]);
	assert.equal(afterAbort.code, "SEARCH_ABORTED", `aborting row A settled as ${JSON.stringify(afterAbort).slice(0, 160)}`);
	assert.notEqual(afterAbort.code, "EVERYTHING_WORKER_REPLACED", "row A's abort arrived as a replaced worker instead of an abort");
	await faceModule.everything.apply(rowB.ctx, ROW_CONFIG);
	const finalOutcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve({ notSettledYet: true }), 100))]);
	assert.equal(finalOutcome.code, "SEARCH_ABORTED", `reloading row B changed row A's code to ${finalOutcome.code}`);
	assert.notEqual(finalOutcome.code, "EVERYTHING_WORKER_REPLACED", "row B's reload settled row A's request");
	return "row A kept SEARCH_ABORTED across row B's reload";
});

// P2 契约：五条并发逐条对上串行基线（单在途链，不许交叉）。2a 之后走行句柄。
await live("five concurrent queries match the serial baseline", async () => {
	const offsets = [0, 5, 10, 15, 20];
	const rowRuntime = runtimeFor(rowA.ctx);
	const query = (offset) => rowRuntime.runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 5, exclude: [], offset });
	const serial = [];
	for (const offset of offsets) serial.push((await query(offset)).items.map((item) => item.path));
	const concurrent = await Promise.all(offsets.map((offset) => query(offset)));
	const paths = concurrent.map((found) => found.items.map((item) => item.path));
	assert.deepEqual(paths, serial, "concurrent results differ from the serial baseline");
	return `${offsets.length} pages identical to the serial run`;
});

// P2 契约：SetSort 是进程级状态，但一次带排序的查询不许漏给下一次。
await live("a sorted query does not leak its order into the next one", async () => {
	await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 5, exclude: [], sort: "size", descending: true });
	const bare = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 5, exclude: [] });
	const named = await runQuery(exec, { search: "*.dll" }, { ...base, maxResults: 5, exclude: [], sort: "name" });
	assert.deepEqual(bare.items.map((item) => item.path), named.items.map((item) => item.path), "the bare query did not come back in name order");
	return "bare query matches explicit name order";
});

// A pre-aborted call fails before the SDK round-trip, so it runs without Everything.
const aborter = new AbortController();
aborter.abort();
let abortError;
try {
	await runQuery({ signal: aborter.signal }, { search: "*.dll" }, { ...base, exclude: [] });
} catch (error) {
	abortError = error;
}
check("an aborted signal -> SEARCH_ABORTED", abortError?.code === "SEARCH_ABORTED", abortError?.code);


// --- 3c：组件开关的四组合。断言的是工具名与段 order 的集合，不比个数 ---
// `faceModule` 在 `live` 之后已经加载（2a-t 与 3d 都要按行句柄挂载）。
const FACE_CAPS = { maxResults: 100, timeoutMs: SEARCH_TIMEOUT_MS };
const faceCtx = () => {
	const tools = new Map();
	const sections = [];
	return {
		tools,
		sections,
		ctx: {
			tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
			systemPrompt: { section(section) { sections.push(section); return () => {}; } },
			logger: { warn() {} }
		}
	};
};
const FACE_COMBOS = [
	{ label: 'none', load: () => {}, tools: [], orders: [] },
	{ label: 'everything only', load: (fake) => faceModule.everything.apply(fake.ctx, FACE_CAPS), tools: ['everything_search', 'everything_status'], orders: [3254] },
	{ label: 'anytxt only', load: (fake) => faceModule.anytxt.apply(fake.ctx, FACE_CAPS), tools: ['anytxt_read', 'anytxt_search', 'anytxt_status', 'anytxt_sync_index'], orders: [3255] },
	{ label: 'both faces', load: (fake) => { faceModule.everything.apply(fake.ctx, FACE_CAPS); faceModule.anytxt.apply(fake.ctx, FACE_CAPS); }, tools: ['anytxt_read', 'anytxt_search', 'anytxt_status', 'anytxt_sync_index', 'everything_search', 'everything_status'], orders: [3254, 3255] }
];
const loadedFaces = [];
for (const combo of FACE_COMBOS) {
	const fake = faceCtx();
	combo.load(fake);
	loadedFaces.push(fake);
	const names = [...fake.tools.keys()].sort().join(",");
	const expected = [...combo.tools].sort().join(",");
	check(`the ${combo.label} combination registers exactly its own tools`, names === expected, names === "" ? "(none)" : names);
	const orders = fake.sections.map((section) => section.order).sort((a, b) => a - b).join(",");
	check(`the ${combo.label} combination registers exactly its own prompt sections`, orders === combo.orders.join(","), orders === "" ? "(none)" : orders);
}

// --- 3d：组件裸挂（不给 caps）——UI 那两条「异常」的回归用例 ---
const bareFile = faceCtx();
faceModule.everything.apply(bareFile.ctx);
const bareFileNames = [...bareFile.tools.keys()].sort().join(",");
check("a bare file row registers its two tools without caps", bareFileNames === "everything_search,everything_status", bareFileNames || "(none)");
const bareFileOrders = bareFile.sections.map((section) => section.order).join(",");
check("a bare file row registers prompt section 3254", bareFileOrders === "3254", bareFileOrders || "(none)");
const bareContent = faceCtx();
faceModule.anytxt.apply(bareContent.ctx);
const bareContentNames = [...bareContent.tools.keys()].sort().join(",");
check("a bare content row registers its four tools without caps", bareContentNames === "anytxt_read,anytxt_search,anytxt_status,anytxt_sync_index", bareContentNames || "(none)");
const bareContentOrders = bareContent.sections.map((section) => section.order).join(",");
check("a bare content row registers prompt section 3255", bareContentOrders === "3255", bareContentOrders || "(none)");
const shellOnly = faceCtx();
await plugin.apply(shellOnly.ctx, ROW_CONFIG);
check("the shell registers no tool and no prompt section on its own", shellOnly.tools.size === 0 && shellOnly.sections.length === 0, `${shellOnly.tools.size} tools, ${shellOnly.sections.length} sections`);
const configDefaults = Config({});
check("the shared Config fills the defaults the components rely on", configDefaults.maxResults === DEFAULT_MAX_RESULTS && configDefaults.timeoutMs === SEARCH_TIMEOUT_MS && configDefaults.anytxtUrl === "http://127.0.0.1:9920/rpc" && configDefaults.anytxtTimeoutMs === 15000 && configDefaults.anytxtMaxResults === 20 && configDefaults.anytxtSyncTimeoutMs === 60000, `${configDefaults.maxResults}/${configDefaults.timeoutMs}/${configDefaults.anytxtUrl}/${configDefaults.anytxtTimeoutMs}/${configDefaults.anytxtMaxResults}/${configDefaults.anytxtSyncTimeoutMs}`);
check("the shell and both faces share one Config object", faceModule.everything.Config === Config && faceModule.anytxt.Config === Config && plugin.Config === Config, "identity shared");
check("both component rows carry their own one-line description", typeof faceModule.everything.description === "string" && faceModule.everything.description.length > 0 && typeof faceModule.anytxt.description === "string" && faceModule.anytxt.description.length > 0, `${faceModule.everything.description} | ${faceModule.anytxt.description}`);

// --- 3f：UI 的「说明」列读 row.meta.description，而它只来自 <specifier>/locale/en.json ---
// 宿主 readPluginMeta 对子路径 specifier 不读 package.json、也不 import 模块，所以说明只能落在这个字典里；
// 字典自己又必须能被 exports 解析到，否则解析器拒收、界面那格退回显示 rowId。
const localeRows = [
	{ specifier: "dsh-tool-everything/everything", file: "lib/components/everything/locale/en.json", expected: "文件名检索，走 Everything64.dll" },
	{ specifier: "dsh-tool-everything/anytxt", file: "lib/components/anytxt/locale/en.json", expected: "内容检索，走 Anytxt 本地 9920" }
];
for (const row of localeRows) {
	const parsed = JSON.parse(readRepoFile(row.file));
	check(`the ${row.specifier} locale carries meta.description`, parsed.meta?.description === row.expected, parsed.meta?.description);
	// 名字用它们自己的：字典不写 meta.title，界面 `row.meta?.title ?? row.moduleName` 于是回落成模块名。
	check(`the ${row.specifier} locale leaves meta.title unset`, parsed.meta?.title === void 0, String(parsed.meta?.title));
	// 旧断言在上一行已断言 `title === undefined` 之后又断言 `(title ?? specifier) === specifier`——恒真，
	// 什么都没测出来。改成两件真事：结构上没有 title 键；`??` 的选择顺序确实偏好 title（有就用它）。
	const localeMeta = parsed.meta ?? {};
	check(`the ${row.specifier} locale defines no title key at all`, !Object.prototype.hasOwnProperty.call(localeMeta, "title"), Object.keys(localeMeta).join(","));
	const titled = { title: "X" };
	check(`the ${row.specifier} name column prefers a title when one exists`, (titled.title ?? row.specifier) === "X" && (localeMeta.title ?? row.specifier) === row.specifier, `${titled.title ?? row.specifier} / ${localeMeta.title ?? row.specifier}`);
	let resolved;
	try {
		resolved = fileURLToPath(import.meta.resolve(`${row.specifier}/locale/en.json`));
	} catch (error) {
		resolved = String(error?.code ?? error);
	}
	check(`the ${row.specifier} locale resolves through exports`, resolved === path.join(repoRoot, ...row.file.split("/")), resolved);
	check(`the ${row.specifier} locale is shipped in files`, pkg.files.includes(row.file), row.file);
}

// --- 3g：0.5.0 新增回归：配置路由、path 撞车、坏预算回退 ---
// 只有组件行的 config 生效（外壳行只组 caps、不注册工具），所以 default 值必须从组件行进
// description；这条钉的正是「用户照 README 改配置会不会静默无效」。
const routedFake = faceCtx();
faceModule.everything.apply(routedFake.ctx, { maxResults: 7, timeoutMs: 9000 });
const routedTool = routedFake.tools.get("everything_search");
// description 里那句原文是 `maxResults defaults to ${caps.maxResults}`，所以判据钉 `defaults to 7`：
// 组件行的 maxResults 没被读到的话这里就是 `defaults to 100`。
check("a component-row config reaches the tool description", /defaults to 7\b/.test(routedTool?.description ?? "") && routedTool?.timeoutMs === 9000, `${/defaults to 7\b/.test(routedTool?.description ?? "") ? "defaults to 7" : "default not routed"}, timeoutMs ${routedTool?.timeoutMs}`);

// path 与串内 path: 撞车：两条 path: 会 AND 成 0 条，旧行为是静默丢掉 path 参数，调用方把
// 「参数被吞掉」读成「该目录里没有」。现在必须报参数错误，并给两条出路。
const collisionFake = faceCtx();
faceModule.everything.apply(collisionFake.ctx, FACE_CAPS);
const collisionTool = collisionFake.tools.get("everything_search");
let pathCollision;
try {
	await collisionTool.execute({ search: "ext:zip path:D:/code", path: "C:/Windows" }, exec);
} catch (error) {
	pathCollision = error;
}
check("a path parameter plus a path: term is a named argument error, never silent", /path cannot be combined/.test(pathCollision?.message ?? "") && /drop the path parameter/.test(pathCollision?.message ?? "") && /remove path:/.test(pathCollision?.message ?? ""), `${pathCollision?.message ?? "no error thrown"}`);

// 坏预算：组件行是唯一生效的配置入口，`AbortSignal.timeout` 只收整数且 0..4294967295，
// 非整数 / 越界一律回退默认，不许以一条没有 ANYTXT_* 错误码的裸 RangeError 逃出。
const badCaps = faceModule.anytxt.resolveContentCaps({ anytxtTimeoutMs: -1, anytxtSyncTimeoutMs: 15000.5, anytxtMaxResults: 1e9 });
check("a bad component-row budget falls back to its default instead of a bare RangeError", badCaps.anytxtTimeoutMs === 15000 && badCaps.anytxtSyncTimeoutMs === 60000 && badCaps.anytxtMaxResults === 300, `${badCaps.anytxtTimeoutMs}/${badCaps.anytxtSyncTimeoutMs}/${badCaps.anytxtMaxResults}`);

// --- 0.5.1：清单第 4 节 P0-1 / P1-1 / P1-2 / P2-1 的固化断言 ---
// P0-1：`name*` 前缀通配曾被当字面前缀（实测 0 条），又因为带 `*` 跳过全部路径校验——
// 一处「参数错误伪装成没有匹配」。现在 `dir\*`、`dir\**`、`name*` 一并归一到静态前缀，
// 交给 `path:` 自己的前缀匹配；父目录都不存在的通配 scope 必须走路径类报错。
const scopeDir = path.join(repoRoot, "lib");
const scopeOf = (pathValue) => buildSearch({ search: "*.md", path: pathValue });
const directScope = scopeOf(scopeDir);
// 尾部通配分两种形态，不能合并成一条：`dir\*`／`dir\**` 是「该目录下全部」，等价于直连目录
// （补尾分隔符）；`name*` 是名字前缀，补了分隔符就变成「这个精确目录」，把 `dsh-voice-s*`
// 逼回 0 条（实测直连 `dsh-voice-suite-main` 有 1 个 .md）。两条各钉各的形态。
check("a directory slash wildcard folds to the direct scope", directScope === `*.md path:${scopeDir}\\` && scopeOf(`${scopeDir}\\*`) === directScope && scopeOf(`${scopeDir}\\**`) === directScope, `${scopeOf(`${scopeDir}\\*`)} | ${scopeOf(`${scopeDir}\\**`)} | direct ${directScope}`);
check("a name-prefix wildcard keeps the prefix and takes no trailing separator", scopeOf(`${scopeDir}*`) === `*.md path:${scopeDir}`, scopeOf(`${scopeDir}*`));
// 中间通配（`C:\a*\b`）没有可证明的等价物，必须原样保留——否则一次前缀匹配会被改成精确目录。
check("a wildcard in the middle of a scope is left alone", scopeOf("C:/a*/b") === "*.md path:C:\\a*\\b", scopeOf("C:/a*/b"));
let wildcardMissingParent;
try {
	buildSearch({ search: "*.md", path: path.join(repoRoot, "no-such-dir-42", "anything*") });
} catch (error) {
	wildcardMissingParent = error;
}
check("a wildcard scope under a missing parent is a path error, not a silent zero", wildcardMissingParent instanceof Error && /path does not exist/.test(wildcardMissingParent.message) && /nearest existing parent: C:\\/.test(wildcardMissingParent.message), wildcardMissingParent === void 0 ? "no error thrown" : wildcardMissingParent.message);

// P1-1：负数 offset 必须当场报参数错误，不许静默变成第 0 页（旧行为 `offset:-9` 回
// `Found 2 of 15 results (offset 0)`，一句提示都没有，与 maxResults 的四个越界值不对称）。
let negativeOffsetError;
try {
	await compiledTool.execute({ search: "*.dll", offset: -5 }, { signal: new AbortController().signal });
} catch (error) {
	negativeOffsetError = error;
}
check("a negative offset is a named argument error, never a silent clamp", negativeOffsetError instanceof Error && /offset must be >= 0/.test(negativeOffsetError.message) && /got -5/.test(negativeOffsetError.message), negativeOffsetError === void 0 ? "no error thrown" : negativeOffsetError.message);

// P2-1：`ext:` 空值语义未定义且静默（实测 5 / 1 / 0，既不是「无过滤」也不是错误），现在拒绝。
let emptyExtError;
try {
	parseArgs({ search: "ext:" });
} catch (error) {
	emptyExtError = error;
}
check("an empty ext: clause is an argument error, not an undefined count", emptyExtError instanceof Error && /ext: requires a value/.test(emptyExtError.message), emptyExtError === void 0 ? "no error thrown" : emptyExtError.message);
let bareExtStillWorks = false;
try {
	bareExtStillWorks = parseArgs({ search: "ext:md" }).search === "ext:md" && parseArgs({ search: "*.md ext:md;txt" }).search.endsWith("ext:md;txt");
} catch {
	bareExtStillWorks = false;
}
check("an ext: clause with a value still passes", bareExtStillWorks, "ext:md and ext:md;txt both accepted");

// P1-2：头部契约的形态钉死。历史上同参 `maxResults:10, offset:10` 在轮 3 返回过
// `Found 15 results`（`of` 与 `offset` 双双消失），是跨轮／跨加载漂移，人工复测抓不住，
// 只能靠固化断言。四种页形里三种必须匹配同一个正则；countOnly 走自己那条已文档化的
// 形态（`Found N matches (count only)`，另有精确等值断言钉着），这里显式断它不匹配分页正则。
const HEADER_SHAPE = /^Found \d+ of \d+ results \(offset \d+\)/;
const pagedPage = (offset, shown, total, truncated) => formatOutput({
	items: Array.from({ length: shown }, (_unused, index) => ({ path: `C:\\f${index}.md`, folder: false, size: 10, mtime: -1 })),
	total,
	truncated,
	offset,
	nextOffset: truncated ? offset + shown : void 0,
	dbLoaded: true,
	excluded: 3
});
const fullPage = pagedPage(7, 7, 20, true);
const tailPage = pagedPage(15, 5, 20, false);
const emptyPage = pagedPage(20, 0, 20, false);
const pastEndPage = pagedPage(40, 0, 20, false);
check("the four page shapes keep the header contract", [fullPage, tailPage, emptyPage, pastEndPage].every((text) => HEADER_SHAPE.test(text.split("\n")[0])) && !HEADER_SHAPE.test(pagedPage(0, 0, 20, false).replace("Found 0 matches (count only)", "")) && /count only/.test(formatOutput({ items: [], total: 20, truncated: false, countOnly: true, dbLoaded: true }).split("\n")[0]), [fullPage, tailPage, emptyPage, pastEndPage].map((text) => text.split("\n")[0]).join(" | "));
check("the tail page and the empty page both print a dash for nextOffset", /^shown 5 \/ total 20 \/ nextOffset -$/m.test(tailPage) && /^shown 0 \/ total 20 \/ nextOffset -$/m.test(emptyPage), `${tailPage.split("\n")[1]} | ${emptyPage.split("\n")[1]}`);
let headerDriftRound = -1;
for (let round = 0; round < 20; round++) {
	if (![fullPage, tailPage, emptyPage, pastEndPage].every((text) => HEADER_SHAPE.test(text.split("\n")[0]))) {
		headerDriftRound = round;
		break;
	}
}
check("the header shape holds over 20 consecutive renders", headerDriftRound === -1, headerDriftRound === -1 ? "20/20 identical shape" : `drifted at round ${headerDriftRound}`);

// P1-3：通配 scope 20 次压测。同写法 `...\\default-workspace\\*` 在轮 2/3/4 给过 1 / 0 / 0，
// 单轮成功不算证据。基线取直连目录的真机计数，四种写法各跑 20 次，逐次与基线相等。
await live("wildcard spellings answer the identical count 20 times in a row", async () => {
	const countFor = async (scopeValue) => (await runQuery(exec, { search: "*", path: scopeValue }, { ...base, maxResults: 1, exclude: [], countOnly: true })).total;
	const directTotal = await countFor(scopeDir);
	assert.ok(directTotal > 0, `the direct scope answered ${directTotal}`);
	const spellings = [scopeDir, `${scopeDir}*`, `${scopeDir}\\*`, `${scopeDir}\\**`];
	const report = [];
	for (const spelling of spellings) {
		const totals = [];
		for (let round = 0; round < 20; round++) totals.push(await countFor(spelling));
		// 两种尾部形态不能共用一个期望值：`dir\*`／`dir\**` 折成该目录自身，必须等于直连基线；
		// `name*` 是纯字符串前缀，Everything 的 path: 连目录自身也匹配（实测 lib 前缀 24、直连 23），
		// 所以它只判「20 次恒等且 >= 直连」——那是前缀语义，不是漂移。
		const exactForm = spelling === scopeDir || spelling.slice(scopeDir.length).startsWith(String.fromCharCode(92));
		if (exactForm) assert.deepEqual(totals, Array.from({ length: 20 }, () => directTotal), `${spelling} drifted: ${JSON.stringify(totals)} (direct baseline ${directTotal})`);
		else {
			assert.equal(new Set(totals).size, 1, `${spelling} name-prefix drifted: ${JSON.stringify(totals)}`);
			assert.ok(totals[0] >= directTotal, `${spelling} answered ${totals[0]}, below the direct baseline ${directTotal}`);
		}
		report.push(`${spelling === scopeDir ? "direct" : spelling.slice(scopeDir.length)} ${directTotal}x20`);
	}
	return report.join(", ");
});

// --- 0.5.2：清单 v5 第 5 节「改成常驻测试」两项 ---
// FIX-11：9 种页形的头部契约（数值取清单第 6 节 H1–H9）。首行按前缀比，因为排除条数是合法
// 后缀；shown 行逐字比。两个边界必须这样钉：恰好用尽给 `-`（给 15 会让调用方白翻一页空页）、
// 子目录中页给 4（证明 `-` 不是到处乱给）。
const shapeRows = [
	["H1 full page", 8, 7, 15, "-", "Found 7 of 15 results (offset 8)"],
	["H2 tail page", 11, 4, 15, "-", "Found 4 of 15 results (offset 11)"],
	["H3 tail page", 12, 3, 15, "-", "Found 3 of 15 results (offset 12)"],
	["H4 last item", 14, 1, 15, "-", "Found 1 of 15 results (offset 14)"],
	["H5 exactly used up", 6, 9, 15, "-", "Found 9 of 15 results (offset 6)"],
	["H6 offset equals total", 15, 0, 15, "-", "Found 0 of 15 results (offset 15)"],
	["H7 far past the end", 99, 0, 15, "-", "Found 0 of 15 results (offset 99)"],
	["H8 subdirectory middle page", 2, 2, 5, "4", "Found 2 of 5 results (offset 2)"],
	["H9 sibling of H3", 10, 5, 15, "-", "Found 5 of 15 results (offset 10)"]
];
const shapeFailures = [];
for (const [label, offset, shown, total, nextOffset, head] of shapeRows) {
	const text = formatOutput({
		items: Array.from({ length: shown }, (_unused, index) => ({ path: `C:\\f${index}.md`, folder: false, size: 10, mtime: -1 })),
		total,
		truncated: false,
		offset,
		nextOffset: nextOffset === "-" ? void 0 : Number(nextOffset),
		dbLoaded: true
	});
	const first = text.split("\n")[0];
	const statsLine = text.split("\n")[1];
	if (!first.startsWith(head)) shapeFailures.push(`${label} header: ${first}`);
	if (statsLine !== `shown ${shown} / total ${total} / nextOffset ${nextOffset}`) shapeFailures.push(`${label} stats: ${statsLine}`);
}
check("the nine page shapes keep the header contract", shapeFailures.length === 0, shapeFailures.length === 0 ? "9/9 header + stats lines exact" : shapeFailures.join(" | "));
// H9 的同参重复：同一调用连发 20 次必须逐字节一致（历史漂移是跨轮次的，只能在这里钉）。
const h9Texts = new Set(Array.from({ length: 20 }, () => formatOutput({
	items: Array.from({ length: 5 }, (_unused, index) => ({ path: `C:\\f${index}.md`, folder: false, size: 10, mtime: -1 })),
	total: 15,
	truncated: false,
	offset: 10,
	dbLoaded: true
})));
check("one page shape renders byte-identically 20 times", h9Texts.size === 1, `${h9Texts.size} distinct rendering(s) over 20 renders`);

// FIX-10：清单的另外两种等价写法（正斜杠、尾分隔符）与直连目录同数，各 20 次。
// 上一轮只覆盖了直连、`*`、`\*`、`\**` 四种，这里补齐 T 组的另两种。
await live("the forward-slash and trailing-separator spellings answer the direct count 20 times", async () => {
	const countFor = async (scopeValue) => (await runQuery(exec, { search: "*", path: scopeValue }, { ...base, maxResults: 1, exclude: [], countOnly: true })).total;
	const directTotal = await countFor(scopeDir);
	assert.ok(directTotal > 0, `the direct scope answered ${directTotal}`);
	const spellings = [
		["forward slash", `${scopeDir.replace(/\\/g, "/")}/*`],
		["trailing separator", `${scopeDir}\\`]
	];
	const report = [];
	for (const [label, spelling] of spellings) {
		const totals = [];
		for (let round = 0; round < 20; round++) totals.push(await countFor(spelling));
		assert.deepEqual(totals, Array.from({ length: 20 }, () => directTotal), `${label} drifted: ${JSON.stringify(totals)} (direct baseline ${directTotal})`);
		report.push(`${label} ${directTotal}x20`);
	}
	return report.join(", ");
});

console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

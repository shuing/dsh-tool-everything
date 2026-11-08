// Offline verification for lib/components/anytxt/anytxt.mjs. Run with: node test/anytxt.verify.mjs
//
// No ATGUI.exe, no network, no Everything: every request goes through an
// injected `fetchImpl`, so the four probe states (ready / missing-tool /
// missing-index / down), the three tool entry points and every ANYTXT_* error
// code are exercised without an Anytxt installation.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const anytxt = await import(pathToFileURL(path.join(repoRoot, "lib", "components", "anytxt", "anytxt.mjs")).href);
// A-a…A-e 的裁决在组件注册面（渲染文本 + 输出 schema）：anytxt.mjs 的钳位函数本身早就对，
// 错的是「钳了却不说」，所以这一套还要加载 index.js 并编译四条工具来取 render。
const anytxtFace = await import(pathToFileURL(path.join(repoRoot, "lib", "components", "anytxt", "index.js")).href);

const {
	ANYTXT_DEFAULT_FRAGMENTS,
	ANYTXT_DEFAULT_LIMIT,
	ANYTXT_MAX_FRAGMENTS,
	ANYTXT_MAX_LIMIT,
	ANYTXT_OFFSET_CAP,
	ANYTXT_ORDER_VALUES,
	AnyTxtError,
	DEFAULT_ANYTXT_URL,
	clampAnytxtFragments,
	clampAnytxtLimit,
	clampAnytxtOffset,
	getFragments,
	getRawText,
	parseAnytxtOrder,
	parseRef,
	probe,
	quoteAware,
	resolveAnytxtUrls,
	searchContent,
	syncIndex,
	normalizeSyncFolder,
	normalizeWindowsDir
} = anytxt;

let passed = 0;
let failed = 0;
const withDetail = (name, detail) => (detail === void 0 ? name : `${name}  —  ${detail}`);
const pass = (name, detail) => {
	passed += 1;
	console.log(`PASS  ${withDetail(name, detail)}`);
};
const fail = (name, detail) => {
	failed += 1;
	console.log(`FAIL  ${withDetail(name, detail)}`);
};
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));
const rejects = async (name, task, expectedCode, pattern) => {
	try {
		await task();
	} catch (error) {
		const message = error?.message ?? "";
		const codeOk = expectedCode === void 0 || error?.code === expectedCode;
		const patternOk = pattern === void 0 || pattern.test(message);
		check(name, codeOk && patternOk && error instanceof AnyTxtError, `${error?.code}: ${message}`);
		return;
	}
	fail(name, "no error thrown");
};

// --- fake transports ---
const jsonReply = (body, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	async json() {
		return body;
	}
});
const outputReply = (output) => jsonReply({ id: 1, jsonrpc: "2.0", result: { data: { output } } });
const refused = () => {
	const error = new Error("fetch failed");
	error.cause = { code: "ECONNREFUSED" };
	return error;
};
const scriptedFetch = (steps) => {
	const calls = [];
	const impl = async (url, options) => {
		calls.push({ url, options });
		const step = steps[calls.length - 1];
		if (step === void 0) throw new Error(`unexpected request ${calls.length} to ${url}`);
		if (step instanceof Error) throw step;
		return step;
	};
	return { impl, calls };
};
const bodyOf = (call) => JSON.parse(call.options.body);

// --- anytxt_search ---
const searchSteps = [
	outputReply({ count: 3 }),
	outputReply({ files: [[7, 1700000000, 1234, "C:\\docs\\a.pdf"], [8, 1700000100, 2048, "C:\\$RECYCLE.BIN\\b.pdf"]] })
];
const search1 = scriptedFetch(searchSteps);
const found = await searchContent({ pattern: "budget report", dir: "C:\\docs", fetchImpl: search1.impl });
check("a search returns the page it asked for", found.items.length === 1 && found.total === 3 && found.offset === 0, JSON.stringify({ items: found.items.length, total: found.total, offset: found.offset }));
check("a ref carries the anytxt: prefix and the fid", found.items[0]?.ref === "anytxt:7" && found.items[0]?.path === "C:\\docs\\a.pdf", `${found.items[0]?.ref} / ${found.items[0]?.path}`);
check("size stays a number and modified an ISO string", found.items[0]?.size === 1234 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(found.items[0]?.modified ?? ""), `${found.items[0]?.size} / ${found.items[0]?.modified}`);
check("the recycle bin is filtered out", found.items.every((item) => !/\$RECYCLE\.BIN/i.test(item.path)), found.items.map((item) => item.path).join(", "));
// 服务器按原始行号分页（实测 offset 1:1 滑动），所以 nextOffset 必须按**原始返回行数**前进，
// 不是过滤后的条数：这一页原始 2 行、过滤后 1 条，下一页起点是 2 而不是 1。
check("nextOffset advances by the raw row count, not the filtered count", found.truncated === true && found.nextOffset === 2 && found.excluded === 3, `${found.truncated} / ${found.nextOffset} / excluded ${found.excluded}`);
check("both requests are POSTs to the default endpoint with redirect error", search1.calls.length === 2 && search1.calls.every((call) => call.url === DEFAULT_ANYTXT_URL && call.options.method === "POST" && call.options.redirect === "error"), search1.calls.map((call) => call.url).join(", "));
const searchBody = bodyOf(search1.calls[0]);
check("the Search body carries pattern, dir, ext and st", searchBody.method === "ATRpcServer.Searcher.V1.Search" && searchBody.params.input.pattern === "budget report" && searchBody.params.input.filterDir === "C:\\docs" && searchBody.params.input.filterExt === "*" && searchBody.params.input.st === "2", JSON.stringify(searchBody.params.input));
const searchText = JSON.stringify(found);
check("a search value survives a lossless JSON round-trip", JSON.stringify(JSON.parse(searchText)) === searchText, `${searchText.length} bytes`);

// 被排除的行落在页内中间时，下一页不能用过滤后条数起头，否则会覆盖原始页尾、把没被
// 排除的行重复发出来。这里构造原始 3 行、其中第 2 行在回收站，再连翻两页比对路径集。
const pages = scriptedFetch([
	outputReply({ count: 4 }),
	outputReply({ files: [[1, 0, 1, "C:\\docs\\p1.pdf"], [2, 0, 1, "C:\\$RECYCLE.BIN\\p2.pdf"], [3, 0, 1, "C:\\docs\\p3.pdf"]] }),
	outputReply({ files: [[4, 0, 1, "C:\\docs\\p4.pdf"]] })
]);
const firstPage = await searchContent({ pattern: "x", dir: "C:\\docs", limit: 3, fetchImpl: pages.impl });
const secondPage = await searchContent({ pattern: "x", dir: "C:\\docs", limit: 3, offset: firstPage.nextOffset, fetchImpl: pages.impl });
const firstPaths = new Set(firstPage.items.map((item) => item.path));
const overlap = secondPage.items.filter((item) => firstPaths.has(item.path));
check("a filtered row advances the page without repeating rows", firstPage.items.length === 2 && firstPage.nextOffset === 3 && overlap.length === 0, `${firstPage.items.length} rows, nextOffset ${firstPage.nextOffset}, overlap ${overlap.length}`);

// 排除是默认值而不是定律：`exclude: ""` 关掉它，回收站里的行必须回来，且头部不再声称排除了东西。
const noExclude = scriptedFetch([outputReply({ count: 1 }), outputReply({ files: [[5, 0, 1, "C:\\$RECYCLE.BIN\\kept.pdf"]] })]);
const kept = await searchContent({ pattern: "x", dir: "C:\\docs", exclude: "", fetchImpl: noExclude.impl });
check("exclude: \"\" turns the default exclusions off", kept.items.length === 1 && kept.excluded === 0 && /kept\.pdf$/.test(kept.items[0]?.path ?? ""), JSON.stringify({ items: kept.items.length, excluded: kept.excluded }));
const customExclude = scriptedFetch([outputReply({ count: 1 }), outputReply({ files: [] })]);
const custom = await searchContent({ pattern: "x", dir: "C:\\docs", exclude: "node_modules; .git", fetchImpl: customExclude.impl });
check("a custom exclude list replaces the defaults and is counted", custom.excluded === 2, String(custom.excluded));

const quoted = scriptedFetch([outputReply({ count: 1 }), outputReply({ files: [] })]);
await searchContent({ pattern: '"exact phrase"', dir: "C:\\docs", fetchImpl: quoted.impl });
const quotedInput = bodyOf(quoted.calls[0]).params.input;
// 实测：本 build 完全忽略 `st`（回显里没有它），整句语义只由 `pattern` 内的引号决定。
// 旧实现把引号剥掉再补 st=1，等于删掉唯一生效的信号——带引号与裸词命中数完全相同。
check("a quoted pattern keeps its quotes in pattern", quotedInput.pattern === '"exact phrase"' && quotedInput.st === "1", JSON.stringify(quotedInput));

const paged = scriptedFetch([outputReply({ count: 3 }), outputReply({ files: [[9, 0, 10, "C:\\docs\\c.pdf"]] })]);
const page2 = await searchContent({ pattern: "x", dir: "C:\\docs", offset: 2, limit: 5, ext: "pdf;docx", fetchImpl: paged.impl });
const pagedInput = bodyOf(paged.calls[1]).params.input;
check("offset, limit and ext reach GetResult unchanged", pagedInput.offset === 2 && pagedInput.limit === 5 && typeof pagedInput.limit === "number" && pagedInput.filterExt === "pdf;docx", JSON.stringify({ offset: pagedInput.offset, limit: pagedInput.limit, ext: pagedInput.filterExt }));
check("the last page reports no nextOffset", page2.offset === 2 && page2.truncated === false && page2.nextOffset === void 0, JSON.stringify(page2));
check("a missing mtime drops the key instead of writing undefined", page2.items[0] !== void 0 && !("modified" in page2.items[0]) && page2.items[0].size === 10, JSON.stringify(page2.items[0]));

check("limit clamps into 1-300", clampAnytxtLimit(0) === 1 && clampAnytxtLimit(9999) === ANYTXT_MAX_LIMIT && clampAnytxtLimit(void 0) === ANYTXT_DEFAULT_LIMIT, `${clampAnytxtLimit(0)} / ${clampAnytxtLimit(9999)} / ${clampAnytxtLimit(void 0)}`);
check("offset clamps into the signed 32-bit range GetResult accepts", clampAnytxtOffset(-5) === 0 && clampAnytxtOffset(1.9) === 1 && clampAnytxtOffset(2147483648) === 2147483647 && clampAnytxtOffset(4294967295) === 2147483647 && ANYTXT_OFFSET_CAP === 2147483647, `${clampAnytxtOffset(-5)} / ${clampAnytxtOffset(1.9)} / ${clampAnytxtOffset(2147483648)} / ${clampAnytxtOffset(4294967295)} / cap ${ANYTXT_OFFSET_CAP}`);
check("quoteAware never rewrites a bare pattern", quoteAware("a & b").st === "2" && quoteAware("a & b").pattern === "a & b", JSON.stringify(quoteAware("a & b")));
check("quoteAware keeps the quotes a phrase needs, and only trims around them", quoteAware('"a b"').pattern === '"a b"' && quoteAware('  "a b"  ').pattern === '"a b"', JSON.stringify(quoteAware('  "a b"  ')));

// order：0-4 五值实测，缺省仍是 0（行为与加参数之前一致）；非法值在参数层就拒，不下发。
const ordered = scriptedFetch([outputReply({ count: 2 }), outputReply({ files: [] })]);
await searchContent({ pattern: "x", dir: "C:\\docs", order: 2, fetchImpl: ordered.impl });
check("an explicit order reaches GetResult", bodyOf(ordered.calls[1]).params.input.order === 2, String(bodyOf(ordered.calls[1]).params.input.order));
const defaultOrder = scriptedFetch([outputReply({ count: 2 }), outputReply({ files: [] })]);
await searchContent({ pattern: "x", dir: "C:\\docs", fetchImpl: defaultOrder.impl });
check("an omitted order asks for the default order", bodyOf(defaultOrder.calls[1]).params.input.order === 0, String(bodyOf(defaultOrder.calls[1]).params.input.order));
await rejects("an out-of-range order is an argument error", () => searchContent({ pattern: "x", dir: "C:\\docs", order: 5, fetchImpl: ordered.impl }), "ANYTXT_INVALID_ARGUMENT", /order must be one of/);
check("the order whitelist is the five measured values", [...ANYTXT_ORDER_VALUES.keys()].join(",") === "0,1,2,3,4" && parseAnytxtOrder(void 0) === 0, [...ANYTXT_ORDER_VALUES.keys()].join(","));

await rejects("a missing dir is an argument error", () => searchContent({ pattern: "x", fetchImpl: search1.impl }), "ANYTXT_INVALID_ARGUMENT", /dir/);
await rejects("a blank dir is an argument error", () => searchContent({ pattern: "x", dir: "   ", fetchImpl: search1.impl }), "ANYTXT_INVALID_ARGUMENT", /dir/);
// 实测：filterDir 用正斜杠回 0 命中且不报错（静默假阴性），所以形状在插件侧归一。
const slashed = scriptedFetch([outputReply({ count: 0 })]);
await searchContent({ pattern: "x", dir: "C:/Users/x/docs", fetchImpl: slashed.impl });
check("a forward-slash dir reaches the server as backslashes", bodyOf(slashed.calls[0]).params.input.filterDir === "C:\\Users\\x\\docs", bodyOf(slashed.calls[0]).params.input.filterDir);
const trailingDir = scriptedFetch([outputReply({ count: 0 })]);
await searchContent({ pattern: "x", dir: "C:\\Users\\x\\docs\\", fetchImpl: trailingDir.impl });
check("a trailing separator is dropped from dir", bodyOf(trailingDir.calls[0]).params.input.filterDir === "C:\\Users\\x\\docs", bodyOf(trailingDir.calls[0]).params.input.filterDir);
check("the normalizer keeps a drive root as C:\\ and never asks about existence", normalizeWindowsDir("C:/") === "C:\\" && normalizeWindowsDir("D:\\") === "D:\\" && normalizeWindowsDir(" c:/x/y/ ") === "c:\\x\\y", `${normalizeWindowsDir("C:/")} / ${normalizeWindowsDir("D:\\")} / ${normalizeWindowsDir(" c:/x/y/ ")}`);
await rejects("a blank pattern is an argument error", () => searchContent({ pattern: "  ", dir: "C:\\docs", fetchImpl: search1.impl }), "ANYTXT_INVALID_ARGUMENT", /pattern/);
await rejects("a remote endpoint is refused", () => searchContent({ pattern: "x", dir: "C:\\docs", url: "http://10.0.0.5:9920", fetchImpl: search1.impl }), "ANYTXT_ENDPOINT_REMOTE", /local/);
check("the 9921 fallback is only offered on the default port", resolveAnytxtUrls("http://127.0.0.1:9920").length === 2 && resolveAnytxtUrls("http://127.0.0.1:9999").length === 1, resolveAnytxtUrls("http://127.0.0.1:9920").join(", "));
// ATGUI 的 RPC 在 /rpc 上（根路径是帮助网页，POST 过去 404）：只给 origin 的配置要自动补路径，
// 回退口同路径换端口。
check("an origin-only endpoint gains the /rpc path, and the fallback keeps it", resolveAnytxtUrls("http://127.0.0.1:9920").join(",") === "http://127.0.0.1:9920/rpc,http://127.0.0.1:9921/rpc", resolveAnytxtUrls("http://127.0.0.1:9920").join(","));

const fallback = scriptedFetch([refused(), outputReply({ count: 2 }), refused(), outputReply({ files: [] })]);
const viaFallback = await searchContent({ pattern: "x", dir: "C:\\docs", fetchImpl: fallback.impl });
check("the 9921 fallback answers when 9920 is unreachable", viaFallback.total === 2 && fallback.calls[3]?.url === "http://127.0.0.1:9921/rpc", fallback.calls.map((call) => call.url).join(" -> "));

await rejects("an unreachable endpoint reports ANYTXT_DOWN with the socket code", () => searchContent({ pattern: "x", dir: "C:\\docs", url: "http://127.0.0.1:9999", fetchImpl: scriptedFetch([refused()]).impl }), "ANYTXT_DOWN", /ECONNREFUSED/);
await rejects("a non-2xx answer reports ANYTXT_HTTP", () => searchContent({ pattern: "x", dir: "C:\\docs", fetchImpl: scriptedFetch([jsonReply({}, 502)]).impl }), "ANYTXT_HTTP", /502/);
await rejects("a JSON-RPC error reports ANYTXT_RPC", () => searchContent({ pattern: "x", dir: "C:\\docs", fetchImpl: scriptedFetch([jsonReply({ id: 1, jsonrpc: "2.0", error: { code: -32000, message: "bad query" } })]).impl }), "ANYTXT_RPC", /bad query/);
await rejects("non-JSON reports ANYTXT_BAD_OUTPUT", () => searchContent({
	pattern: "x",
	dir: "C:\\docs",
	fetchImpl: scriptedFetch([{ ok: true, status: 200, async json() { throw new SyntaxError("Unexpected token <"); } }]).impl
}), "ANYTXT_BAD_OUTPUT", /non-JSON/);
await rejects("a reply without result.data.output reports ANYTXT_RPC", () => searchContent({ pattern: "x", dir: "C:\\docs", fetchImpl: scriptedFetch([jsonReply({ id: 1, result: { data: {} } })]).impl }), "ANYTXT_RPC", /result\.data\.output/);
await rejects("a timeout reports ANYTXT_TIMEOUT", () => searchContent({ pattern: "x", dir: "C:\\docs", fetchImpl: scriptedFetch([Object.assign(new Error("timed out"), { name: "TimeoutError" })]).impl }), "ANYTXT_TIMEOUT", /timed out/);
// `AbortSignal.timeout` 只收整数且 0..4294967295（实测 -1 / 1.5 / 1e10 都抛 RangeError）。
// 计时器构造放在 try 之外时，坏预算会以一条没有 ANYTXT_* 码的裸 RangeError 逃出去。
await rejects("an unusable request budget is a coded argument error, not a bare RangeError", () => searchContent({ pattern: "x", dir: "C:\\docs", timeoutMs: -1, fetchImpl: async () => { throw new Error("must not be called"); } }), "ANYTXT_INVALID_ARGUMENT", /budget/);
const aborter = new AbortController();
aborter.abort();
await rejects("a cancelled call reports ANYTXT_ABORTED", () => searchContent({ pattern: "x", dir: "C:\\docs", signal: aborter.signal, fetchImpl: scriptedFetch([refused()]).impl }), "ANYTXT_ABORTED", /aborted/);

// --- anytxt_read: fragments ---
const frags = scriptedFetch([outputReply({ text: ["alpha *<<*hit*>>* beta", "", "gamma *<<*x*>>*"] })]);
const fragments = await getFragments({ ref: "anytxt:7", query: "hit", max: 1, fetchImpl: frags.impl });
check("fragments strip the highlight markers and honour max", fragments.snippets.length === 1 && fragments.snippets[0] === "alpha hit beta" && fragments.totalSnippets === 2, JSON.stringify(fragments));
check("a fragment answer carries no max key", !("max" in fragments), JSON.stringify(Object.keys(fragments)));
// 实测 GetFragmentAll 恒返 8 段（传 3/8/32/300 都回 8，回显恒 limit: 8），所以对外上限就是 8：
// 承诺 32 等于承诺一个服务端永远不会发出的一页，客户端只能往下切。
check("fragments clamp into 1-8, the ceiling the server actually sends, and carry no extra max key", clampAnytxtFragments(0) === 1 && clampAnytxtFragments(99) === ANYTXT_MAX_FRAGMENTS && ANYTXT_MAX_FRAGMENTS === 8 && clampAnytxtFragments(void 0) === ANYTXT_DEFAULT_FRAGMENTS && ANYTXT_DEFAULT_FRAGMENTS === 8 && !("max" in fragments), `${clampAnytxtFragments(0)} / ${clampAnytxtFragments(99)} / ${clampAnytxtFragments(void 0)} / ceiling ${ANYTXT_MAX_FRAGMENTS} / max-key ${String("max" in fragments)}`);
const fragInput = bodyOf(frags.calls[0]).params.input;
check("fragments call GetFragmentAll with the parsed fid and the query", bodyOf(frags.calls[0]).method === "ATRpcServer.Searcher.V1.GetFragmentAll" && fragInput.fid === "7" && fragInput.pattern === "hit", JSON.stringify(fragInput));

// --- anytxt_read: full text ---
const longText = "0123456789".repeat(10);
const raw = scriptedFetch([outputReply({ text: longText })]);
const full = await getRawText({ ref: "anytxt:7", offset: 10, maxChars: 20, fetchImpl: raw.impl });
check("full text slices by offset and maxChars", full.text === longText.slice(10, 30) && full.totalChars === 100 && full.returned === 20 && full.offset === 10 && full.truncated === true, JSON.stringify({ total: full.totalChars, returned: full.returned, offset: full.offset }));
check("a full read past the end is an empty, untruncated answer", (await getRawText({ ref: "anytxt:7", offset: 500, fetchImpl: scriptedFetch([outputReply({ text: longText })]).impl })).text === "");
// 实测：fid 不存在时服务端回 `errno 1` + `text: null`，有效 fid 回 `errno 0` + 字符串。
// 不读 errno 就只能把「这个 id 没有文档」渲染成 `0 of 0 characters` 的成功——调用方会以为
// 读到一个空文档。`GetFragmentAll` 两种 fid 都回 errno 0，所以只有 full 这条能报。
const missingFidReply = jsonReply({ id: 1, jsonrpc: "2.0", result: { errno: 1, data: { output: { text: null } } } });
await rejects("a fid the index does not hold reports ANYTXT_FID_NOT_FOUND, not an empty document", () => getRawText({ ref: "anytxt:999", fetchImpl: scriptedFetch([missingFidReply]).impl }), "ANYTXT_FID_NOT_FOUND", /no document for anytxt:999/);
check("an explicit errno 0 still reads normally", (await getRawText({ ref: "anytxt:7", maxChars: 4, fetchImpl: scriptedFetch([jsonReply({ id: 1, jsonrpc: "2.0", result: { errno: 0, data: { output: { text: longText } } } })]).impl })).text === longText.slice(0, 4), "errno 0 accepted");
check("a reply carrying no errno field is not judged missing", (await getRawText({ ref: "anytxt:7", maxChars: 4, fetchImpl: scriptedFetch([outputReply({ text: longText })]).impl })).text === longText.slice(0, 4), "absent errno tolerated");
await rejects("a read reply without result.data.output is still ANYTXT_RPC", () => getRawText({ ref: "anytxt:7", fetchImpl: scriptedFetch([jsonReply({ id: 1, jsonrpc: "2.0", result: {} })]).impl }), "ANYTXT_RPC", /result\.data\.output/);
await rejects("a foreign ref is refused", () => getRawText({ ref: "everything:7", fetchImpl: raw.impl }), "ANYTXT_INVALID_ARGUMENT", /anytxt:/);
await rejects("a ref without an id is refused", () => getRawText({ ref: "anytxt:", fetchImpl: raw.impl }), "ANYTXT_INVALID_ARGUMENT", /id/);
await rejects("fragments need a query", () => getFragments({ ref: "anytxt:7", fetchImpl: frags.impl }), "ANYTXT_INVALID_ARGUMENT", /query/);
const parsedRef = parseRef(" anytxt:42 ");
check("parseRef splits the engine from the id", parsedRef.engine === "anytxt" && parsedRef.id === "42", JSON.stringify(parsedRef));
await rejects("a ref without an engine prefix is refused", () => parseRef("123"), "ANYTXT_INVALID_ARGUMENT", /anytxt:/);
await rejects("a ref from another engine names that engine back", () => parseRef("everything:123"), "ANYTXT_INVALID_ARGUMENT", /everything/);

// --- anytxt_status: the four probe states ---
const readyProbe = await probe({ dir: "C:\\", fetchImpl: scriptedFetch([outputReply({ count: 4 })]).impl, installed: () => true });
check("probe state ready", readyProbe.state === "ready" && readyProbe.ok === true && readyProbe.code === "ANYTXT_READY" && readyProbe.url === DEFAULT_ANYTXT_URL, JSON.stringify(readyProbe));
check("the probe value carries no repair fields", Object.keys(readyProbe).sort().join(",") === "code,message,ok,state,url", Object.keys(readyProbe).join(","));
// 服务端对 Search 有应答本身就证明内容检索可用："索引里没有这个探针词"与"索引为空"从一次
// 探针里分不出来，据此回 ok:false 会把健康的索引报成不可用（旧判据正是如此）。
const zeroHitProbe = await probe({ dir: "C:\\", fetchImpl: scriptedFetch([outputReply({ count: 0 })]).impl, installed: () => true });
check("a probe that matches nothing is still ready", zeroHitProbe.state === "ready" && zeroHitProbe.ok === true && zeroHitProbe.code === "ANYTXT_READY" && /probe word matched nothing/.test(zeroHitProbe.message), JSON.stringify(zeroHitProbe));
const missingTool = await probe({ dir: "C:\\", fetchImpl: scriptedFetch([refused(), refused()]).impl, installed: () => null });
check("probe state missing-tool", missingTool.state === "missing-tool" && missingTool.ok === false && missingTool.code === "ANYTXT_MISSING_TOOL" && /ATGUI\.exe/.test(missingTool.message), JSON.stringify(missingTool));
const downProbe = await probe({ dir: "C:\\", fetchImpl: scriptedFetch([refused(), refused()]).impl, installed: () => true });
check("probe state down when it is installed but silent", downProbe.state === "down" && downProbe.ok === false && downProbe.code === "ANYTXT_DOWN", JSON.stringify(downProbe));
const httpProbe = await probe({ dir: "C:\\", fetchImpl: scriptedFetch([jsonReply({}, 500)]).impl, installed: () => true });
check("probe reports an HTTP failure as down, never as a verdict on the index", httpProbe.state === "down" && httpProbe.code === "ANYTXT_HTTP", JSON.stringify(httpProbe));
const remoteProbe = await probe({ url: "http://10.0.0.5:9920", fetchImpl: async () => { throw new Error("must not be called"); } });
check("a remote endpoint reads as down and never throws", remoteProbe.state === "down" && remoteProbe.ok === false && remoteProbe.code === "ANYTXT_ENDPOINT_REMOTE", JSON.stringify(remoteProbe));

// --- anytxt_sync_index: the one call that changes index state ---
// 三条实测坑：正斜杠路径回 errno 0 却不建库、不存在的目录同样回 0、相对路径什么都不指。
// 所以路径归一与存在性校验必须在插件侧，且 errno 之外还要看 errno 本身。
check("a forward-slash folder is normalized to backslashes", normalizeSyncFolder("C:/Users/x/docs", { exists: () => true }) === "C:\\Users\\x\\docs", normalizeSyncFolder("C:/Users/x/docs", { exists: () => true }));
check("a trailing separator is dropped before sending", normalizeSyncFolder("C:\\Users\\x\\docs\\", { exists: () => true }) === "C:\\Users\\x\\docs", normalizeSyncFolder("C:\\Users\\x\\docs\\", { exists: () => true }));
await rejects("a relative folder is an argument error", () => syncIndex({ folder: "docs", exists: () => true, fetchImpl: async () => { throw new Error("must not be called"); } }), "ANYTXT_INVALID_ARGUMENT", /absolute/);
await rejects("a missing folder is an argument error", () => syncIndex({ folder: "C:\\definitely-missing-42", exists: () => false, fetchImpl: async () => { throw new Error("must not be called"); } }), "ANYTXT_INVALID_ARGUMENT", /does not exist/);
await rejects("a blank folder is an argument error", () => syncIndex({ folder: "   ", exists: () => true, fetchImpl: async () => { throw new Error("must not be called"); } }), "ANYTXT_INVALID_ARGUMENT", /folder/);
const syncOk = scriptedFetch([jsonReply({ id: 1, jsonrpc: "2.0", result: { errno: 0, data: { output: {} } } })]);
const synced = await syncIndex({ folder: "C:/Users/x/docs", exists: () => true, fetchImpl: syncOk.impl });
// 码不借 ANYTXT_READY：那个码在本文件里定义为 anytxt_status 的判决，拿来报「请求已接受」
// 会让一次写路径的结果读起来像一次探活判决。
check("a sync reports the normalized folder and that the request was accepted", synced.folder === "C:\\Users\\x\\docs" && synced.ok === true && synced.code === "ANYTXT_SYNC_ACCEPTED" && /background/.test(synced.message), JSON.stringify(synced));
const syncBody = bodyOf(syncOk.calls[0]);
check("the sync call uses the v1 method with folder directly in params", syncBody.method === "anytxt.v1.syncIndex" && syncBody.params.folder === "C:\\Users\\x\\docs" && syncBody.params.input === void 0, JSON.stringify(syncBody.params));
const syncBad = scriptedFetch([jsonReply({ id: 1, jsonrpc: "2.0", result: { errno: 7, data: { output: {} } } })]);
await rejects("a non-zero errno is refused as ANYTXT_RPC", () => syncIndex({ folder: "C:\\Users\\x\\docs", exists: () => true, fetchImpl: syncBad.impl }), "ANYTXT_RPC", /errno 7/);
await rejects("a down endpoint during sync reports ANYTXT_DOWN", () => syncIndex({ folder: "C:\\Users\\x\\docs", url: "http://127.0.0.1:9999", exists: () => true, fetchImpl: scriptedFetch([refused()]).impl }), "ANYTXT_DOWN", /ECONNREFUSED/);

// --- A-a…A-e（清单 v5 第 8.3 节）：内容面的「静默 / 口径」五项 ---
// 断言打在模型真正读到的那段文本上，而不是钳位函数本身：这五项没有一条是功能错误，全是
// 「钳了却不说 / 口径没写」。所以这里编译四条工具，取 output.render 的结果来断。
const faceTools = new Map();
anytxtFace.applyAnytxtTools({ tools: { register(tool) { faceTools.set(tool.name, tool); } } }, { anytxtUrl: "http://127.0.0.1:9/rpc", anytxtTimeoutMs: 1000, anytxtMaxResults: ANYTXT_DEFAULT_LIMIT, anytxtSyncTimeoutMs: 1000 });
check("the four anytxt tools compile for the render checks", ["anytxt_read", "anytxt_search", "anytxt_status", "anytxt_sync_index"].every((name) => faceTools.has(name)), [...faceTools.keys()].join(","));
const renderSearch = (value) => faceTools.get("anytxt_search").output.render({}, value)[0].text;
const renderRead = (value) => faceTools.get("anytxt_read").output.render({}, value)[0].text;
const searchSchemaKeys = Object.keys(faceTools.get("anytxt_search")?.output?.schema?.properties ?? {});
const readSchemaKeys = Object.keys(faceTools.get("anytxt_read")?.output?.schema?.properties ?? {});
check("A-a/A-d the search schema can carry the clamp and scope fields", searchSchemaKeys.includes("limitClampedFrom"), searchSchemaKeys.join(","));
check("A-c the read schema can carry the clamp field", readSchemaKeys.includes("maxClampedFrom"), readSchemaKeys.join(","));
const zeroScoped = renderSearch({ items: [], total: 0, truncated: false, offset: 0, excluded: 3 });
const zeroPlain = renderSearch({ items: [], total: 0, truncated: false, offset: 0, excluded: 0 });
check("A-e a zero-hit page offers drop ext, and drop exclude only when rules are in force", /widen: drop ext/.test(zeroScoped) && /drop exclude/.test(zeroScoped) && /widen: drop ext/.test(zeroPlain) && !/drop exclude/.test(zeroPlain), `${zeroScoped.split("\n").pop()} | ${zeroPlain.split("\n").pop()}`);
check("A-d a zero-hit page never claims a before-exclusion total", !/before exclusion/.test(zeroScoped) && !/before exclusion/.test(zeroPlain), zeroScoped.split("\n")[0]);
const pastEnd = renderSearch({ items: [], total: 46, truncated: false, offset: 999999, excluded: 3 });
check("A-b an empty page past the end names the overshoot", /offset 999999 is past the end/.test(pastEnd) && /total is 46/.test(pastEnd), pastEnd.split("\n")[0]);
const clampedLimit = renderSearch({ items: [], total: 46, truncated: false, offset: 0, excluded: 3, limitClampedFrom: 0 });
const plainLimit = renderSearch({ items: [], total: 46, truncated: false, offset: 0, excluded: 3 });
check("A-a an out-of-range limit is reported, and an in-range page stays clean", /limit 0 is outside 1-300 and was clamped/.test(clampedLimit) && !/is outside 1-300/.test(plainLimit), clampedLimit.split("\n").join(" | "));
const scopedTotal = renderSearch({ items: [], total: 46, truncated: false, offset: 0, excluded: 3 });
check("A-d the total is labelled as the count before exclusion, only when rules apply", /total 46 is the count before exclusion/.test(scopedTotal) && !/before exclusion/.test(renderSearch({ items: [], total: 46, truncated: false, offset: 0, excluded: 0 })), scopedTotal.split("\n")[0]);
const clampedRead = renderRead({ ref: "anytxt:7", mode: "full", text: "abc", totalChars: 3, returned: 3, offset: 0, truncated: false, maxClampedFrom: 40001 });
check("A-c a clamped max is reported on a read, and an in-range read stays clean", /max 40001 is outside the range/.test(clampedRead) && !/is outside the range/.test(renderRead({ ref: "anytxt:7", mode: "full", text: "abc", totalChars: 3, returned: 3, offset: 0, truncated: false })), clampedRead.split("\n").pop());

// A-c（fragments 侧）：`max` 是段数（1–8），钳位同样要留痕。只在 full 分支印提示的话，
// `max: 0` / `max: 9` 被钳成 1 / 8 仍然一声不响——与 full 侧 `40001 -> 40000` 的待遇不一致。
const clampedFragments = renderRead({ ref: "anytxt:7", mode: "fragments", query: "hit", totalSnippets: 8, snippets: ["alpha"], maxClampedFrom: 0 });
const plainFragments = renderRead({ ref: "anytxt:7", mode: "fragments", query: "hit", totalSnippets: 8, snippets: ["alpha"] });
check("A-c a clamped fragments max is reported, and an in-range fragment answer stays clean", /max 0 is outside the range/.test(clampedFragments) && !/is outside the range/.test(plainFragments), clampedFragments.split("\n").pop());

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

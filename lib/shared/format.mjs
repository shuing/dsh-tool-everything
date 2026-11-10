/**
 * Model-facing formatting for the Everything search surface: the `Found N` header
 * line, one row per path, and the pending/completed call presentations.
 *
 * Moved verbatim out of `lib/index.js` so a second surface can share one formatter.
 * Function bodies are unchanged: same signatures, same output byte for byte.
 */
/** Indent of a compacted row under its directory line: four spaces, matched by the tests. */
const INDENT = "    ";
/** Directory separator this formatter emits. Everything is a Windows-only surface. */
const DIR_SEPARATOR = "\\";
/**
 * Deepest `..\` hop a compacted row may use before it prints the absolute directory
 * instead. Calibrated against a real 13-row page: hops up to three levels saved
 * characters, while the ten-level hop that crossed two unrelated trees cost more in
 * dots than the prefix it removed and made the row unreadable - all hop lines together
 * were 31% of the compacted page (6.9% after this cap), and the page's total saving
 * fell from 22.3% to 20.9%. Three is where the character saving and the reader's
 * ability to count the climb still agree.
 */
const MAX_HOP_LEVELS = 3;

/** Format a byte count as a short human-readable size; empty when unknown (-1). */
function formatSize(size) {
	if (size < 0) return "";
	if (size < 1024) return `${size} B`;
	const units = ["KB", "MB", "GB", "TB", "PB"];
	let value = size / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * One `YYYY-MM-DD HH:MM:SS` stamp in the **local** zone, or `undefined` for an
 * unusable Date. One implementation for both faces: Everything hands over epoch
 * milliseconds and Anytxt hands over an ISO string, and two copies of this
 * arithmetic would drift the moment a column is added.
 *
 * Local on purpose. The content index stores UTC (`toISOString`), and printing
 * that wall clock unlabelled put it eight hours away from Everything's local
 * column for the very same file - two answers, no timezone marker on either.
 */
function formatLocalStamp(at) {
	if (!(at instanceof Date) || Number.isNaN(at.getTime())) return void 0;
	const pad = (value) => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * One result's local-time column, fixed width (19 chars) so the column never
 * drifts. A missing mtime (-1) prints a dash: `new Date(-1)` would render 1970,
 * which is a wrong answer rather than a missing one.
 */
function formatMtime(mtime) {
	if (!(mtime >= 0)) return "-".padEnd(19, " ");
	return formatLocalStamp(new Date(mtime)) ?? "-".padEnd(19, " ");
}

/** Format one result path with its readable size/folder marker and local mtime for the model-facing text. */
function formatItem(item) {
	// size 读不到（-1）时补一个 `-` 占位：旧写法整列省掉，路径与时间之间只剩一个
	// TAB，行里既可能少一列、也读不出「大小未知」和「大小是 0」的区别。三列恒在，
	// 缺值一律打 `-`，不印 1970、也不留连着的 TAB。
	const size = item.folder ? "<DIR> " + (formatSize(item.size) || "-") : formatSize(item.size) || "-";
	return `${item.path}\t${size}\t${formatMtime(item.mtime)}`;
}

/**
 * Split one absolute path into its parent directory segments and its leaf name.
 * `C:\a\b.txt` → { dirs: ["C:", "a"], leaf: "b.txt" }.
 */
function splitPath(path) {
	const segments = String(path).split("\\");
	return { dirs: segments.slice(0, -1), leaf: segments[segments.length - 1] };
}

/**
 * The overlapping directory segments of two directories: `C:\a\b` vs `C:\a\c` → 2.
 * Counting segments (not characters) keeps `C:\ab` and `C:\abc` from being read as
 * sharing a prefix they do not have.
 */
function sharedSegments(left, right) {
	const limit = Math.min(left.length, right.length);
	let shared = 0;
	while (shared < limit && left[shared] === right[shared]) shared++;
	return shared;
}

/**
 * One row of the path-compacted body: the path as a `..\`-relative hop from the
 * previous row when `previous` is given, otherwise the full directory line.
 *
 * Only the directory is ever shortened. The leaf name and the size/mtime columns
 * are byte-identical to {@link formatItem}, so a compacted row still carries the
 * same facts - it just stops repeating a directory that is already on screen.
 * The first row of every page is printed in full on purpose: a page that starts
 * mid-directory still has to be locatable on its own.
 *
 * Three cases deliberately fall back to an absolute directory instead of a hop,
 * because a hop there would be a path that does not exist (or a row nobody can
 * read): the first row of a page, a different drive letter, and a climb deeper
 * than {@link MAX_HOP_LEVELS}. Everything else is a `..\`-prefixed remainder.
 */
function formatItemCompacted(item, previous) {
	const { dirs, leaf } = splitPath(item.path);
	const size = item.folder ? "<DIR> " + (formatSize(item.size) || "-") : formatSize(item.size) || "-";
	const columns = `${leaf}\t${size}\t${formatMtime(item.mtime)}`;
	// 盘符根（`C:\one.txt` 的 dirs 只有 ["C:"]）必须带尾分隔符：印成 `C:` 会被读成
	// 「当前目录下叫 C: 的东西」，`C:\` 才是一个真正的目录。
	const absolute = (segments) => {
		const joined = segments.join(DIR_SEPARATOR);
		return segments.length === 1 ? `${joined}${DIR_SEPARATOR}` : joined;
	};
	// fallback 行只拼一次：下面两条 return 共用它，避免同一串重复构造两遍。
	const absoluteRow = `${absolute(dirs)}\n${INDENT}${columns}`;
	// 首行与换盘符先判：`..` 到不了另一块盘，`..\D:\b` 是假路径，读的人会去
	// `C:\D:` 下面找。两者都退回整条绝对路径，宁可多花几十字符也不印假跳转。
	if (previous === void 0 || dirs[0] !== previous[0]) return absoluteRow;
	const shared = sharedSegments(dirs, previous);
	// 跳转本身也要付字符：超过 MAX_HOP_LEVELS 层时点号比省下的前缀还长，且数不清。
	if (previous.length - shared > MAX_HOP_LEVELS) return absoluteRow;
	// 同目录才允许只打缩进行。`shared === dirs.length` 在**目录变浅**时也成立
	// （`C:\a\b` 之后出现 `C:\a` 的文件），此时缩进行会被读成仍在上一个更深目录里
	// ——实测踩过：`...\_extract\briefing.zip` 后紧跟 `...\sample.zip`，两者被看成
	// 同一个 `_extract` 目录。所以变浅必须另起一行目录，哪怕 rest 为空。
	if (shared === dirs.length && dirs.length === previous.length) return `${INDENT}${columns}`;
	// 爬出共享段要**按层数**写 `..\`，不是固定一个。实测踩过：从深度 10 的
	// `...\Dism++\Config\Languages` 跳到共享 5 层的另一个 `图吧工具箱202502\...`，
	// 只写一个 `..` 会解析到 `...\Dism++\Config\..\图吧工具箱202502` —— 一个不存在的
	// 兄弟目录。上跳层数 = 上一层目录的深度 − 共享段数。
	const climbs = previous.length - shared;
	const rest = dirs.slice(shared).join(DIR_SEPARATOR);
	// `..\` 自带分隔符，所以 rest 为空（回到上级）时不能再补一个，否则成 `..\` + `\`。
	// 例：`C:\a\b\c` → `C:\a\b` 印成 `..\`，由解析器上跳一层还原。
	const hop = `${`..${DIR_SEPARATOR}`.repeat(climbs)}${rest}`;
	return `${hop}\n${INDENT}${columns}`;
}

/**
 * Format the model-facing result: a header line with counts, the retained
 * paths, and a truncation footer carrying the offset that continues the page.
 */
function formatOutput(value) {
	const offset = typeof value.offset === "number" ? value.offset : 0;
	const excluded = typeof value.excluded === "number" && value.excluded > 0 ? ` (${value.excluded} exclusion rule${value.excluded === 1 ? "" : "s"} applied)` : "";
	// countOnly 走独立文案：`offset + items.length < total` 那套分支对它没有意义，
	// 「Found 0 of 15712」加「pass offset 0」两句一起把人往沟里带。
	// `offset > 0` 同样算「分页」：此前只在 truncated 时印 offset，于是 `total=11 / offset=10`
	// 那一页变成 `Found 11 results`，读起来像「这就是全部」，脚本解析还得写两套正则。
	const counted = value.countOnly === true
		? `Found ${value.total} matches (count only)`
		: value.truncated || offset > 0
			? `Found ${value.items.length} of ${value.total} results (offset ${offset})`
			: `Found ${value.total} ${value.total === 1 ? "result" : "results"}`;
	const unloaded = value.dbLoaded === false ? " — the Everything index is not loaded yet, so matches may be missing → call everything_status" : "";
	// pathMustExist:false 丢掉 scope 时必须写明，否则「整盘的结果」会被当成「该目录下的结果」。
	const pathIgnored = typeof value.pathIgnored === "string" && value.pathIgnored.length > 0 ? ` — path ignored: does not exist (${value.pathIgnored}), so this searched the whole index (the scope was dropped only because the call passed allDrives: true with pathMustExist: false, so these results are not from that folder)` : "";
	// 采样这件事写进结构里，别指望调用方自己记住「maxResults 与 total 是两回事」：非
	// countOnly 一律在 Found 行下面补一行 `shown N / total M / nextOffset X`（没有下
	// 一页就 `-`）。原有 Found 行的语义一行不动，countOnly 不出这一行。
	const stats = value.countOnly === true ? "" : `\nshown ${value.items.length} / total ${value.total} / nextOffset ${typeof value.nextOffset === "number" ? value.nextOffset : "-"}`;
	// 钳位必须写进结果：`maxResults: 0` 会被钳成 1，旧输出一声不响，调用方读成「传 0 应该没结果」。
	const clampNote = typeof value.maxResultsClampedFrom === "number" ? `\nmaxResults ${value.maxResultsClampedFrom} is outside 1-500 and was clamped; this page is not the size that was asked for` : "";
	// P0-2：offset 的越界钳位同样写进结果头。否则 `offset: 4294967296` 被压成 4294967295 后，
	// 头部只写着这个钳后的值，读起来是「你要的页越界了」，而不是「你传的值被改了」。
	const offsetClampNote = typeof value.offsetClampedFrom === "number" ? `\noffset ${value.offsetClampedFrom} is above the 32-bit offset ceiling and was clamped; this page is not the page that was asked for` : "";
	// type 没追加同理：串里已经带了 file:/folder:，再塞一个就是 AND 成 0 条——这种
	// 参数自相矛盾必须标出来，别让调用方把「参数撞车」读成「索引里没有」。
	const typeIgnored = typeof value.typeIgnored === "string" && value.typeIgnored.length > 0 ? ` — type not appended: the search already carries file:/folder:, so type: ${value.typeIgnored} was skipped` : "";
	// 空页不是「没有结果」：offset 越过总数时这一页天然为空，但 total 仍大于 0，
	// 印成 `Found 0 of 15 results` 会被读成「这个范围里什么都没有」，读的人就不再往里翻。
	// 实测 offset:100 / total:15 正是这样，此前一句提示都没有。
	const pastEnd = value.countOnly !== true && value.items.length === 0 && value.total > 0 && offset >= value.total
		? ` — offset ${offset} is past the end: total is ${value.total}, so this page is empty; page from offset 0..${Math.max(0, value.total - 1)} or drop offset`
		: "";
	// 零命中不是「不存在」，只是「这次查询在索引里没有命中」。四条门控：countOnly 只报数、
	// 不追加；索引未加载时空结果无定论（改由上面的 → call everything_status 指路）；
	// pathIgnored / typeIgnored 非空说明范围被改写过，也不能替那个范围下断言。
	//
	// 措辞给的是**证据边界**（只覆盖已索引的卷），不是一句「≠ missing」：边界能让模型推理
	// 出「换个范围再试」，否定式只能被记住；而且它不再把 missing 这个词引进来。
	const zeroInterpretable =
		value.countOnly !== true && value.total === 0 && value.items.length === 0 && value.dbLoaded !== false && pathIgnored.length === 0 && typeIgnored.length === 0;
	// P2-1：范围生效时用「范围版」替换「索引版」，绝不叠加——两句同屏会互相否定
	// （前一句断言「索引里没有」，后一句又说「只是这个目录没匹配」），读的人只能随机信一句。
	// 0 命中无法区分「目录确实空」与「该目录不在索引覆盖内」，所以范围版把两种成因并列，
	// 并明说 other folders were not searched。不带 path 的零命中首行逐字不变。
	const scopeLimited = zeroInterpretable && typeof value.scopeApplied === "string" && value.scopeApplied.length > 0;
	const notInIndex = zeroInterpretable
		? scopeLimited
			? ` = no match inside path: ${value.scopeApplied} (this folder only; nothing matches there, or that folder is not indexed - other folders were not searched)`
			: " = no match in the index (indexed volumes only)"
		: "";
	// 0 命中时补一条「放宽」的出路，与截断页脚的 narrow 对称：结果多时告诉怎么收窄，一条
	// 都没有时只留一句「不许说文件不存在」是不够的——此刻需要的是一条能走的下一步。排除
	// 规则是零命中的一个常见成因，条数已经写在头行，所以当次生效时把 `exclude:""` 一并给出。
	// 与 notInIndex 共用 zeroInterpretable：门控不成立时两者一起消失，不会互相漂。
	// 不带前导换行：门控保证 total 为 0，body 必为空，所以头行后面那个 `\n\n` 就是分隔。
	const widenFooter = zeroInterpretable
		? `(widen: drop path:, drop ext:, or relax the pattern${typeof value.excluded === "number" && value.excluded > 0 ? `; ${value.excluded} exclusion rule${value.excluded === 1 ? "" : "s"} ${value.excluded === 1 ? "is" : "are"} on - pass exclude:"" to include ${value.excluded === 1 ? "it" : "them"} back` : ""}.)`
		: "";
	const header = `${counted}${excluded}${unloaded}${pathIgnored}${typeIgnored}${pastEnd}${notInIndex}${stats}${clampNote}${offsetClampNote}`;
	// 压缩只在 sort:path 时开启：Everything 按路径排序时同目录天然相邻，前缀重复才是
	// 噪声；按 name/size 排序时目录被打散（实测 500 条：name 151 段、size 164 段、
	// path 仅 90 段），此时压缩只会把「..\」乱跳堆给读的人。开关只看 sort，不看文案，
	// 所以翻页语义不变——每页首行仍打印完整目录，nextOffset 契约一字未动。
	const compact = value.compacted === true;
	// 一次遍历：每一行把自己的 dirs 留给下一行当 previous。原来在 reduce 里再
	// `splitPath` 前一项，等于每条路径解析两次；500 条页面看不出，但是纯浪费。
	// 每页首行的 previous 恒为 undefined，所以页首总是完整目录（翻页后仍可定位）。
	let compactedBody = "";
	let previousDirs;
	for (const item of value.items) {
		const row = formatItemCompacted(item, previousDirs);
		compactedBody = compactedBody.length === 0 ? row : `${compactedBody}\n${row}`;
		previousDirs = splitPath(item.path).dirs;
	}
	const body = compact ? compactedBody : value.items.map(formatItem).join("\n");
	// `<DIR>` 是目录、不是文件——这层语义原先只在 README 里，模型在结果行看到 `<DIR>` 时
	// 读不到解释。所以只在本次结果真有目录项时，末尾单起一行说出来；纯文件结果、零命中、
	// countOnly（items 为空）一律不带，否则就成了每条结果都挂一句无用提示。
	const folderHint = value.items.some((item) => item.folder === true) ? "\n\n(<DIR> is a folder, never read it.)" : "";
	// countOnly 没有 items，也不该进截断分支：只报数，再给一句怎么拿路径。
	if (value.countOnly === true) return `${header}\n\n(pass countOnly: false, or narrow the search, to list the paths.)`;
	// P2-2：body / folderHint / widenFooter 全空时（越界空页）原来会留下一个尾随空行，
	// 「这次查询本来就是空的」和「输出拼坏了」在文本上分不开。只有真有内容时才拼第二段。
	const tail = `${body}${folderHint}${widenFooter}`;
	if (!value.truncated) return tail.length > 0 ? `${header}\n\n${tail}` : header;
	// 页脚只剩一句措辞：续页 offset 由 offset + items.length 给出。原来 nextOffset 非数字时
	// 另写过一句「只显示前 N 条、建议调大 maxResults」的措辞，那条在生产路径上构造不出来
	// （`truncated` 为真时 everything/index.js:456 必写数字 nextOffset），方向也与「用
	// nextOffset 翻页」相反，所以整个分支删掉，只剩下面这一句。
	const footer = `(Showing ${value.items.length} starting at offset ${offset}; pass offset ${offset + value.items.length} or narrow the search to see more.)`;
	// P2-2：空页（offset 越过末尾）没有 body，原来会拼出 `header\n\n\n\nfooter`，少一段空行更干净。
	if (body.length === 0) return `${header}\n\n${footer}${folderHint}`;
	return `${header}\n\n${body}\n\n${footer}${folderHint}`;
}

/**
 * Pending-call presentation: a search card titled by the search text.
 */
function presentCall(args) {
	return {
		card: "generic",
		title: `Everything ${args.search}`,
		kind: "search",
		rawInput: args.search
	};
}

/**
 * Completed-call presentation: the search card projected from the result's
 * `presentationMeta` (the retained path list, with the truncation signal).
 */
function presentResult(_args, result) {
	if (result.isError) return void 0;
	const meta = result.meta;
	if (typeof meta !== "object" || meta === null) return void 0;
	const { paths, truncated, total } = meta;
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string") || typeof truncated !== "boolean" || typeof total !== "number") return void 0;
	return {
		card: "search",
		shape: "paths",
		paths,
		truncated,
		total
	};
}

// `formatItemCompacted` 不导出：它只服务 `formatOutput` 的 compacted 分支，外部
// 没有调用方（测试也是通过 formatOutput 观察结果）。导出面保持最小，避免有人
// 绕过 formatOutput 直接拼行、跳过 header / footer / <DIR> 提示这些契约。
export { formatItem, formatLocalStamp, formatOutput, formatSize, presentCall, presentResult };

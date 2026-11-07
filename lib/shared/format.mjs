/**
 * Model-facing formatting for the Everything search surface: the `Found N` header
 * line, one row per path, and the pending/completed call presentations.
 *
 * Moved verbatim out of `lib/index.js` so a second surface can share one formatter.
 * Function bodies are unchanged: same signatures, same output byte for byte.
 */
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
	const size = item.folder ? "<DIR>" : formatSize(item.size) || "-";
	return `${item.path}\t${size}\t${formatMtime(item.mtime)}`;
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
	const counted = value.countOnly === true
		? `Found ${value.total} matches (count only)`
		: value.truncated
			? `Found ${value.items.length} of ${value.total} results (offset ${offset})`
			: `Found ${value.total} ${value.total === 1 ? "result" : "results"}`;
	const unloaded = value.dbLoaded === false ? " — the Everything index is not loaded yet, so matches may be missing → call everything_status" : "";
	// pathMustExist:false 丢掉 scope 时必须写明，否则「整盘的结果」会被当成「该目录下的结果」。
	const pathIgnored = typeof value.pathIgnored === "string" && value.pathIgnored.length > 0 ? ` — path ignored: does not exist (${value.pathIgnored}), so this searched the whole index` : "";
	// 采样这件事写进结构里，别指望调用方自己记住「maxResults 与 total 是两回事」：非
	// countOnly 一律在 Found 行下面补一行 `shown N / total M / nextOffset X`（没有下
	// 一页就 `-`）。原有 Found 行的语义一行不动，countOnly 不出这一行。
	const stats = value.countOnly === true ? "" : `\nshown ${value.items.length} / total ${value.total} / nextOffset ${typeof value.nextOffset === "number" ? value.nextOffset : "-"}`;
	// type 没追加同理：串里已经带了 file:/folder:，再塞一个就是 AND 成 0 条——这种
	// 参数自相矛盾必须标出来，别让调用方把「参数撞车」读成「索引里没有」。
	const typeIgnored = typeof value.typeIgnored === "string" && value.typeIgnored.length > 0 ? ` — type not appended: the search already carries file:/folder:, so type: ${value.typeIgnored} was skipped` : "";
	// 零命中不是「不存在」，只是「不在索引里」：这条红线原来只写在工具 description 里，
	// 搬到结果首行尾部，模型做判断那一刻就看得到。四条门控：countOnly 只报数、不追加；
	// 索引未加载时空结果无定论（改由上面的 → call everything_status 指路）；
	// pathIgnored / typeIgnored 非空说明范围被改写过，也不能直接断言「不在索引里」。
	const notInIndex =
		value.countOnly !== true && value.total === 0 && value.items.length === 0 && value.dbLoaded !== false && pathIgnored.length === 0 && typeIgnored.length === 0
			? " = not in index (≠ missing)"
			: "";
	const header = `${counted}${excluded}${unloaded}${pathIgnored}${typeIgnored}${notInIndex}${stats}`;
	const body = value.items.map(formatItem).join("\n");
	// `<DIR>` 是目录、不是文件——这层语义原先只在 README 里，模型在结果行看到 `<DIR>` 时
	// 读不到解释。所以只在本次结果真有目录项时，末尾单起一行说出来；纯文件结果、零命中、
	// countOnly（items 为空）一律不带，否则就成了每条结果都挂一句无用提示。
	const folderHint = value.items.some((item) => item.folder === true) ? "\n\n(<DIR> is a folder, never read it.)" : "";
	// countOnly 没有 items，也不该进截断分支：只报数，再给一句怎么拿路径。
	if (value.countOnly === true) return `${header}\n\n(pass countOnly: false, or narrow the search, to list the paths.)`;
	if (!value.truncated) return `${header}\n\n${body}${folderHint}`;
	// 页脚只剩一句措辞：续页 offset 由 offset + items.length 给出。原来 nextOffset 非数字时
	// 另写过一句「只显示前 N 条、建议调大 maxResults」的措辞，那条在生产路径上构造不出来
	// （`truncated` 为真时 everything/index.js:456 必写数字 nextOffset），方向也与「用
	// nextOffset 翻页」相反，所以整个分支删掉，只剩下面这一句。
	const footer = `(Showing ${value.items.length} starting at offset ${offset}; pass offset ${offset + value.items.length} or narrow the search to see more.)`;
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

export { formatItem, formatLocalStamp, formatOutput, formatSize, presentCall, presentResult };

/**
 * @module lib/shared/slots.mjs
 *
 * 槽位限流器：同时最多 `limit` 个持有者，按 FIFO 交接。纯逻辑——只用 `setTimeout` 计时、
 * 不碰 Everything64.dll——所以「并发调度」这一层能离线测，不必等 Everything 在跑
 * （live 用例在没装 Everything 的机器上只会 SKIP）。
 *
 * 为什么需要它：插件原先用一条 `rt.chain` 把每条查询串起来（并发是排队不是并行）。
 * 放开并发后同一实例上可以有 N 条在途查询，`limit` 就是 N，同时也是子进程池的容量
 * （见 `lib/components/everything/index.js` 的 `acquireWorker`）。
 *
 * `peak` 是给测试用的观测量：并发用例据此判断「确实重叠过」，而不是比较墙钟时间——
 * 后者在快机器上必然 flaky。
 *
 * `resize` 只作用于**后续准入**：已持有槽位的任务不被打断（缩小时多出来的持有者自然
 * 排空），等待队列在有新空间时按 FIFO 依次放行。调用方每次查询前用当次的 caps 调一次
 * `resize`，所以「同一实例先后用不同并发度」是安全的。
 */

/** 并发上限：每个并发查询背后是一个 node 子进程 + 一个 Everything64.dll 实例。 */
export const MAX_SLOTS = 8;

/**
 * 归一化一个 limit：非有限数、小于 1 一律当 1；大于 `cap` 截到 `cap`。
 * 越界不抛错——这是防「配置写了个 0 或 NaN 就把整条查询路径打死」的那道闸。
 */
export function normalizeLimit(value, cap = MAX_SLOTS) {
	const requested = Number(value);
	if (!Number.isFinite(requested)) return 1;
	return Math.min(cap, Math.max(1, Math.floor(requested)));
}

/**
 * One limiter. `acquire()` resolves when the caller may proceed; every acquire must
 * be paired with exactly one `release()`, or `run()` does both around a task.
 */
export function createSlotLimiter(initialLimit = 1, cap = MAX_SLOTS) {
	let size = normalizeLimit(initialLimit, cap);
	const waiters = [];
	let active = 0;
	let peak = 0;

	/** 记一次准入；没有空间就不动。峰值只在这里和 `resize` 里更新。 */
	const admit = () => {
		if (active >= size) return false;
		active += 1;
		if (active > peak) peak = active;
		return true;
	};
	/**
	 * 释放一个槽位：优先直接交给队首（槽位换手，`active` 不变），否则递减。
	 * 换手时不碰 `peak`——持有者数量没变。
	 */
	const handoff = () => {
		const next = waiters.shift();
		if (next !== void 0) {
			next.resume();
			return;
		}
		if (active > 0) active -= 1;
	};
	/** 无限等待的准入；只有不需要给调用方兜底的场景才用它。 */
	const acquire = async () => {
		if (admit()) return;
		await new Promise((resolve) => waiters.push({ resume: resolve }));
	};
	/**
	 * 在给定窗口内等一个槽位：拿到 `true`；窗口用完 `false`。
	 *
	 * 超时的等待者**必须把自己从队列里摘掉**：`handoff` 是按队首交棒的，留着它就会在之后
	 * 被放行一次、白占一个名额（名额泄漏），而且那次放行没有调用方在等。
	 * 窗口非有限或 <= 0 视为「不等」：满了立刻 `false`。
	 */
	const acquireWithin = async (ms) => {
		if (admit()) return true;
		const window = Number(ms);
		if (!Number.isFinite(window) || window <= 0) return false;
		return await new Promise((resolve) => {
			const waiter = {
				resume: () => {
					clearTimeout(timer);
					resolve(true);
				}
			};
			const timer = setTimeout(() => {
				const at = waiters.indexOf(waiter);
				if (at >= 0) waiters.splice(at, 1);
				resolve(false);
			}, window);
			waiters.push(waiter);
		});
	};
	const release = () => handoff();
	/**
	 * 持槽跑一个任务，最多等 `waitMs`；任务抛错也保证释放。
	 * @returns `{ admitted: false }` = 窗口内没等到槽位（调用方据此报具名错误）；
	 *          否则 `{ admitted: true, value }`。
	 */
	const runWithin = async (waitMs, task) => {
		if (!(await acquireWithin(waitMs))) return { admitted: false };
		try {
			return { admitted: true, value: await task() };
		} finally {
			release();
		}
	};
	/** 改容量：放宽时立刻按 FIFO 放行等待者；收紧时只影响后续准入。 */
	const resize = (next) => {
		size = normalizeLimit(next, cap);
		while (waiters.length > 0 && active < size) {
			active += 1;
			if (active > peak) peak = active;
			waiters.shift().resume();
		}
		return size;
	};
	return {
		acquire,
		acquireWithin,
		release,
		resize,
		runWithin,
		/** 读一次当前状态；测试与探描写这一份快照。 */
		snapshot: () => ({ limit: size, active, waiting: waiters.length, peak }),
		get limit() {
			return size;
		},
		get active() {
			return active;
		},
		get waiting() {
			return waiters.length;
		},
		get peak() {
			return peak;
		},
		/** 峰值基线挪到当前 active：让一段用例只观察自己那一段的并发度。 */
		resetPeak: () => {
			peak = active;
		}
	};
}

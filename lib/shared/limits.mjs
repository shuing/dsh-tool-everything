/**
 * @module lib/shared/limits.mjs
 *
 * 硬上限的唯一定义处：两条组件行都从这里取，谁都不许各复制一套。
 *
 * 数值在这里写成字面量，是因为组件导入本文件、本文件不能再反向导入组件（会成环），
 * 与 `lib/shared/config.mjs` 同一条约定。`lib/index.js` 仍以同名再导出
 * `OFFSET_CAP` / `clampOffset`，所以调用方与两个测试入口一行不动。
 */

import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";

/**
 * Hard ceiling on `offset`. `Everything_SetOffset` takes a uint32, and 2^32
 * silently wrapped back to the first page (measured: `offset: 4294967296`
 * returned the offset-0 page while `value.offset` echoed the raw argument). An
 * offset past the end stays an empty page - that is already what it meant below
 * the limit - so the clamp only closes the wrap; nothing inside the range moves.
 *
 * 这个数只给 Everything 用。Anytxt 侧另有自己的上限（`ANYTXT_OFFSET_CAP` =
 * 2^31-1，定义在 `lib/components/anytxt/anytxt.mjs`）：`GetResult` 只收有符号
 * 32 位整数，实测 2147483648 起被 `-32602` 拒。两边量级差一倍，不许再互相 alias。
 */
export const OFFSET_CAP = 4294967295;

/**
 * Clamp one requested offset into [0, `cap`]. One implementation for every call
 * site - `execute`, `runQueryUnlocked` and both Anytxt reads - because copies
 * drift, and a drifted offset clamp either wraps to page 0 again or hands the
 * caller a page number the backend never saw. Non-finite input falls back to 0,
 * the same page a missing offset means. A missing `cap` is {@link OFFSET_CAP}.
 */
export function clampOffset(value, cap = OFFSET_CAP) {
	const requested = Number(value ?? 0);
	return Number.isFinite(requested) ? Math.min(cap, Math.max(0, Math.floor(requested))) : 0;
}

/**
 * One timer budget, validated before it can reach `AbortSignal.timeout`.
 *
 * That constructor takes an integer in 0..4294967295 and throws a bare
 * `RangeError` for anything else (measured: -1, 1.5 and 1e10 all throw), which
 * used to escape with no ANYTXT_* / EVERYTHING_* code and read as an internal
 * crash instead of a bad config. A non-integer, a value below 1 or one above
 * `MAX_TIMER_DELAY_MS` therefore falls back to `fallback` here - the same
 * tolerance the caps resolvers already had for a missing key, extended to a bad
 * value. One implementation, because two copies would drift on the upper bound.
 */
export function resolveBudgetMs(value, fallback) {
	const requested = Number(value);
	if (!Number.isInteger(requested) || requested < 1) return fallback;
	return requested > MAX_TIMER_DELAY_MS ? fallback : requested;
}

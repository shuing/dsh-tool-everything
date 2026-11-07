/**
 * @module lib/shared/prompt-orders.mjs
 *
 * prompt 段 order 的唯一来源：一行一个数，一张表里数字全局唯一。
 *
 * 组件不许硬编码数字，也不许用 `+1` 之类算术凑顺序——ops 的
 * `SECTION_ORDERS + (shell ? 1 : 0)` 只够两个组件，第三个必撞，正是 105/106 那个病的模子。
 * 以后要加第三个开 prompt 段的组件，就在这张表里加一行。
 */
export const PROMPT_ORDERS = Object.freeze({
	everythingSearch: 3254,
	anytxtSearch: 3255
});

/**
 * @module lib/shared/type-name.mjs
 *
 * `typeof` with `null` called out, for a probe's expected/got pair.
 *
 * 外壳的 `probeHost` 与文件面组件的 `assertSignal` 都要把「期望什么、实际是什么」
 * 写进报错消息，判定只能有一处：两份近似实现漂一个字符，模型读到的诊断就变了。
 * 与 `shared/format.mjs` 同层，属包本体，组件按路径引用即可。
 */

/** `typeof` with `null` called out, for a probe's expected/got pair. */
export function typeName(value) {
	return value === null ? "null" : typeof value;
}

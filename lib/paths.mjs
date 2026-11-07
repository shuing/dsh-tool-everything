/**
 * @module lib/paths.mjs
 *
 * 包内路径的唯一一处定义：随包发行的 Everything SDK DLL，以及查询 worker 的入口。
 *
 * 一律从 `lib/` 起算，不数 `../` 层数：`lib/sdk.mjs` 与 `lib/components/everything/index.js`
 * 深浅不同，数层数的写法搬一次文件就指错地方——这个包已经因为「同一表达式两份拷贝」
 * 栽过一次（`sdk.mjs` 头注释记的就是这条）。本文件不随任何组件移动，谁要去 DLL 或
 * 起 worker，都从这里取。
 *
 * `workerUrl` 指向 worker 文件的当前位置；worker 哪天搬进组件，只改这一行。
 */
import { fileURLToPath } from "node:url";

/** 随包发行的 Everything SDK DLL（`native/Everything64.dll`）。 */
export const dllPath = fileURLToPath(new URL("../native/Everything64.dll", import.meta.url));

/** 查询 worker 的入口 URL（`lib/components/everything/query-worker.mjs`）。 */
export const workerUrl = new URL("./components/everything/query-worker.mjs", import.meta.url);

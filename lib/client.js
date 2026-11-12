/**
 * 客户端半边：把 `dsh-tool-everything` **组件行**（`dsh-tool-everything-everything`）的配置页
 * 贡献给 DSH 的「插件」页。
 *
 * 两个契约（都来自宿主，不是本包自造）：
 *
 * 1. 槽位 `plugins.row.config` 是 `keyed` 的，key = `<包名>#<行 id>`（`rowConfigKey`）。
 *    注册了它，那一行才会长出「配置」入口；没注册就没有入口——这正是本包存在的理由。
 * 2. 表单本身由宿主的通用服务提供：页面把 `{ state, mutate }` 作为 `form` 传给渲染函数。
 *    `state` 是 schema 解析后的快照（`value` / `user` / `base` / `revision` / `writable`），
 *    `mutate(ops)` 收 `SettingsPathOpView[]`：`{ op: 'set', path: [字段], value }` 或
 *    `{ op: 'unset', path: [字段] }`。字段名就是行配置里的键，默认值归共享 Config schema。
 *
 * 这个文件是手写的 UMD 包装（与 tsdown 产物同形：`window.__ModuleLoader__.load({id, factory})`），
 * 所以本包**不需要构建步骤**：运行时的 `require` 负责解析 "react"。
 */
window.__ModuleLoader__.load({
	id: "dsh-tool-everything",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		/** 页面为「一行配置」声明的槽位。 */
		const SLOT_KEY = "plugins.row.config";
		/** `<包名>#<行 id>`：`dsh-tool-everything` 的组件行。 */
		const ROW_KEY = "dsh-tool-everything#dsh-tool-everything-everything";

		/**
		 * 这一行认的三个数字。默认值与钳位归宿主侧的共享 Config schema，这里只负责界面：
		 * 控件范围与提示文案写在这，避免“界面允许 99、后端钳到 8”这种两套说法。
		 */
		const FIELDS = [
			{
				name: "concurrency",
				label: "并发查询数",
				hint: "1 = 单在途（与打补丁前逐字一致）；上限 8。每条在途查询各占一个 forked 子进程（各自一个 Everything64.dll 实例），所以调大是拿内存与磁盘寻道换吞吐。",
				min: 1,
				max: 8
			},
			{ name: "maxResults", label: "单页条数", hint: "1–500；越界会被钳位并在结果头写明从哪里调整而来。", min: 1, max: 500 },
			{ name: "timeoutMs", label: "超时预算（毫秒）", hint: "默认 8000；超时只 SIGKILL 该条查询自己的子进程，不牵连其他在途查询。", min: 1000 }
		];

		const style = {
			wrap: { display: "flex", flexDirection: "column", gap: "14px", padding: "2px 0" },
			status: { fontSize: "12px", opacity: 0.7, lineHeight: 1.7 },
			field: { display: "flex", flexDirection: "column", gap: "6px" },
			head: { display: "flex", alignItems: "center", gap: "8px" },
			label: { fontSize: "13px", fontWeight: 600 },
			tag: { fontSize: "11px", padding: "1px 6px", borderRadius: "999px", border: "1px solid currentColor", opacity: 0.7 },
			controls: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			input: {
				width: "120px",
				padding: "4px 8px",
				borderRadius: "6px",
				border: "1px solid rgba(127,127,127,.45)",
				background: "transparent",
				color: "inherit",
				fontSize: "13px"
			},
			button: {
				padding: "4px 10px",
				borderRadius: "6px",
				border: "1px solid rgba(127,127,127,.45)",
				background: "transparent",
				color: "inherit",
				fontSize: "12px",
				cursor: "pointer"
			},
			hint: { fontSize: "12px", opacity: 0.65, lineHeight: 1.7 },
			note: { fontSize: "12px", opacity: 0.85 }
		};

		/** 快照里这个字段的当前值：优先已解析的 value，再退回用户层。 */
		function readValue(snapshot, name) {
			for (const layer of [snapshot && snapshot.value, snapshot && snapshot.user, snapshot && snapshot.base]) {
				if (layer !== null && typeof layer === "object" && name in layer) return layer[name];
			}
			return void 0;
		}

		/** 用户层里存在这个键 = 这一项被显式覆盖过（值等于默认值也算覆盖）。 */
		function isOverridden(snapshot, name) {
			return Boolean(snapshot && snapshot.user && typeof snapshot.user === "object" && name in snapshot.user);
		}

		/** 一个字段：数字输入 + 保存 / 恢复默认；写入失败或不被接受时把原因写在自己下面。 */
		function Field(props) {
			const form = props.form;
			const spec = props.spec;
			const snapshot = form.state;
			const live = readValue(snapshot, spec.name);
			const [draft, setDraft] = React.useState(() => (live === void 0 ? "" : String(live)));
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState("");
			React.useEffect(() => {
				setDraft(live === void 0 ? "" : String(live));
			}, [live]);
			const writable = snapshot.status === "ready" && snapshot.writable === true;
			const disabled = !writable || busy;
			const write = async (ops, okText) => {
				setBusy(true);
				setNote("");
				try {
					const accepted = await form.mutate(ops);
					setNote(accepted ? okText : "宿主拒绝了这次写入（值可能不在允许范围内）");
				} catch (error) {
					setNote(String((error && error.message) || error));
				} finally {
					setBusy(false);
				}
			};
			const save = () => {
				const value = Number(draft);
				if (!Number.isFinite(value)) {
					setNote("请输入一个数字");
					return;
				}
				return write([{ op: "set", path: [spec.name], value }], "已保存，下一次查询开始生效");
			};
			return React.createElement(
				"div",
				{ style: style.field },
				React.createElement(
					"div",
					{ style: style.head },
					React.createElement("span", { style: style.label }, spec.label),
					isOverridden(snapshot, spec.name) ? React.createElement("span", { style: style.tag }, "已覆盖") : null,
					live === void 0 ? null : React.createElement("span", { style: style.tag }, "当前 " + String(live))
				),
				React.createElement(
					"div",
					{ style: style.controls },
					React.createElement("input", {
						type: "number",
						style: style.input,
						value: draft,
						min: spec.min,
						max: spec.max,
						disabled,
						onChange: (event) => setDraft(event.target.value)
					}),
					React.createElement("button", { type: "button", style: style.button, disabled, onClick: save }, "保存"),
					React.createElement(
						"button",
						{ type: "button", style: style.button, disabled, onClick: () => write([{ op: "unset", path: [spec.name] }], "已恢复默认") },
						"恢复默认"
					)
				),
				React.createElement("div", { style: style.hint }, spec.hint),
				note === "" ? null : React.createElement("div", { style: style.note }, note)
			);
		}

		/** 槽位渲染函数：`summary` 是行内一句话，`page` 是带保存控件的整页。 */
		function RowConfig(props) {
			if (props.view === "summary") return React.createElement("span", null, "并发查询数 / 单页条数 / 超时预算");
			const form = props.form;
			if (!form) return React.createElement("div", { style: style.status }, "这一行暂时拿不到表单：宿主没有为它暴露配置。");
			const snapshot = form.state;
			const note =
				snapshot.status === "ready"
					? snapshot.writable === true
						? "写入后立即生效；恢复默认即删掉用户层里的这一项，回到随包默认值。"
						: "当前 profile 不接受写入（只读）。"
					: "正在读取配置（状态：" + String(snapshot.status) + "）。";
			return React.createElement(
				"div",
				{ style: style.wrap },
				React.createElement("div", { style: style.status }, note),
				FIELDS.map((spec) => React.createElement(Field, { key: spec.name, form, spec }))
			);
		}

		exports.inject = ["slots"];
		exports.apply = (ctx) => {
			const contribute = () => ctx.slots.inject(SLOT_KEY, () => ctx.slots.register({ name: SLOT_KEY, key: ROW_KEY }, RowConfig));
			if (typeof ctx.effect === "function") ctx.effect(contribute);
			else contribute();
		};

		return module.exports;
	}
});

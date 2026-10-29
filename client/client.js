/**
 * dsh-autocompact client half: the "Configure" page for the idle-autocompact
 * row on the Plugins page. It edits the `rules` table (provider / model /
 * minutes) through the host-supplied config form; `rules` is a volatile field,
 * so a save applies without restarting the plugin.
 *
 * Plain JS on purpose: the module table already provides react and the UI
 * primitives, so the package needs no client build step.
 */
window.__ModuleLoader__.load({
	id: "dsh-autocompact",
	factory: (require) => {
		var module = { exports: {} };
		const React = require("react");
		const { Button } = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = React.createElement;

		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.autocompact";
		/** `plugins.row.config` key: `<package name>#<row id>` as the bundle's patch declares the row. */
		const KEY = "dsh-autocompact#idle-autocompact";

		const en = {
			summary: "Compact a session after N idle minutes, per model or provider.",
			hint: "Most specific rule wins: provider + model, then model, then provider. 0 minutes disables a route; unmatched routes are never compacted.",
			provider: "Provider",
			model: "Model",
			minutes: "Idle minutes",
			providerPlaceholder: "any provider",
			modelPlaceholder: "any model",
			empty: "No rules yet, so nothing is compacted.",
			add: "Add rule",
			remove: "Remove",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these rules; they were left for you to correct.",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
		};
		const zh = {
			summary: "会话空闲 N 分钟后自动压缩，可按模型或提供方分别设置。",
			hint: "优先级：提供方 + 模型，其次模型，再次提供方。0 分钟表示该路由不压缩；未匹配的路由从不压缩。",
			provider: "提供方",
			model: "模型",
			minutes: "空闲分钟数",
			providerPlaceholder: "任意提供方",
			modelPlaceholder: "任意模型",
			empty: "还没有规则，因此不会压缩任何会话。",
			add: "添加规则",
			remove: "移除",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些规则，已保留供你修改。",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
		};

		/**
		 * Editable text rows from the saved config section.
		 * @param value - the schema-resolved section the form reports.
		 */
		function draftFrom(value) {
			const rules = value && Array.isArray(value.rules) ? value.rules : [];
			return rules.map((rule) => ({
				provider: rule.provider ?? "",
				model: rule.model ?? "",
				minutes: String(rule.minutes ?? ""),
			}));
		}

		/**
		 * Problems that would make the plugin refuse the table; empty when it is valid.
		 * @param rows - editable text rows.
		 */
		function draftErrors(rows) {
			const errors = [];
			const seen = new Set();
			rows.forEach((row, index) => {
				const label = "Rule " + (index + 1);
				const provider = row.provider.trim();
				const model = row.model.trim();
				if (!provider && !model) errors.push(label + ": needs a provider or model");
				const minutes = row.minutes.trim();
				if (minutes === "" || !Number.isFinite(Number(minutes)) || Number(minutes) < 0) {
					errors.push(label + ": minutes must be a number of 0 or more");
				}
				const key = (provider || "*") + "/" + (model || "*");
				if ((provider || model) && seen.has(key)) errors.push(label + ": duplicate of another rule (" + key + ")");
				seen.add(key);
			});
			return errors;
		}

		/**
		 * One atomic write replacing the whole table.
		 * @param rows - validated editable rows.
		 */
		function rulesToOps(rows) {
			const value = rows.map((row) => {
				const provider = row.provider.trim();
				const model = row.model.trim();
				return {
					...(provider ? { provider } : {}),
					...(model ? { model } : {}),
					minutes: Number(row.minutes),
				};
			});
			return [{ op: "set", path: ["rules"], value }];
		}

		const inputStyle = {
			boxSizing: "border-box",
			height: 32,
			minWidth: 0,
			padding: "0 10px",
			font: "inherit",
			fontSize: 13,
			color: "var(--dsw-alias-label-primary)",
			background: "var(--dsw-alias-bg-layer-3)",
			border: ".5px solid var(--dsw-alias-border-l4)",
			borderRadius: "var(--dsw-radius-md)",
		};
		const rowStyle = { display: "grid", gridTemplateColumns: "1fr 1fr 110px auto", gap: 8, alignItems: "center" };
		const noteStyle = { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" };
		const errorStyle = { ...noteStyle, color: "var(--dsw-alias-state-error-primary)" };

		/**
		 * The row's page: its one-liner, or the editable rules table.
		 * @param props - `view`, locale reader `t`, and the host `form`.
		 */
		function RulesPage(props) {
			const { t, view, form } = props;
			const [draft, setDraft] = React.useState(null);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			if (view === "summary") return t("summary");
			const state = form && form.state;
			if (!state || state.status !== "ready") return h("p", { style: noteStyle }, t("unavailable"));

			const rows = draft ?? draftFrom(state.value);
			const errors = draft ? draftErrors(draft) : [];
			const locked = !state.writable;
			const change = (next) => {
				setFailed(false);
				setDraft(next);
			};
			const edit = (index, field, value) => change(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
			const save = async () => {
				setSaving(true);
				try {
					const accepted = await form.mutate(rulesToOps(draft), state.revision);
					if (accepted) setDraft(null);
					else setFailed(true);
				} finally {
					setSaving(false);
				}
			};
			const field = (index, name, placeholder, extra) => h("input", {
				value: rows[index][name],
				placeholder,
				"aria-label": t(name),
				disabled: locked,
				style: inputStyle,
				onChange: (event) => edit(index, name, event.target.value),
				...extra,
			});

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				h("p", { style: noteStyle }, t("hint")),
				rows.length === 0 ? h("p", { style: noteStyle }, t("empty")) : h("div", { style: rowStyle },
					h("span", { style: noteStyle }, t("provider")),
					h("span", { style: noteStyle }, t("model")),
					h("span", { style: noteStyle }, t("minutes")),
					h("span")),
				rows.map((_, index) => h("div", { key: index, style: rowStyle },
					field(index, "provider", t("providerPlaceholder")),
					field(index, "model", t("modelPlaceholder")),
					field(index, "minutes", "", { inputMode: "decimal" }),
					h(Button, { variant: "outline", size: "sm", disabled: locked, onClick: () => change(rows.filter((__, i) => i !== index)) }, t("remove")))),
				errors.map((message) => h("p", { key: message, style: errorStyle, role: "alert" }, message)),
				failed ? h("p", { style: errorStyle, role: "alert" }, t("saveFailed")) : null,
				locked ? h("p", { style: noteStyle }, t("readOnly")) : null,
				h("div", { style: { display: "flex", gap: 8 } },
					h(Button, { variant: "outline", size: "sm", disabled: locked, onClick: () => change([...rows, { provider: "", model: "", minutes: "10" }]) }, t("add")),
					h(Button, { variant: "primary", size: "sm", disabled: locked || !draft || errors.length > 0 || saving, onClick: save }, saving ? t("saving") : t("save"))));
		}

		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale"];

		/**
		 * Register the row's configuration page.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-autocompact: dictionaries");
			ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: KEY,
				locale: NS,
			}, RulesPage));
		}

		module.exports.name = "dsh-autocompact-client";
		module.exports.NS = NS;
		module.exports.KEY = KEY;
		module.exports.inject = inject;
		module.exports.apply = apply;
		module.exports.draftFrom = draftFrom;
		module.exports.draftErrors = draftErrors;
		module.exports.rulesToOps = rulesToOps;
		module.exports.RulesPage = RulesPage;
		return module.exports;
	},
});

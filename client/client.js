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
			anyProvider: "Any provider",
			anyModel: "Any model",
			empty: "No rules yet, so nothing is compacted.",
			add: "Add rule",
			remove: "Remove",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these rules; they were left for you to correct.",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			unavailableOption: "unavailable",
			catalogLoading: "Loading available models…",
			catalogFailed: "Could not load the available models.",
			catalogEmpty: "No models are currently available.",
			retry: "Retry",
		};
		const zh = {
			summary: "会话空闲 N 分钟后自动压缩，可按模型或提供方分别设置。",
			hint: "优先级：提供方 + 模型，其次模型，再次提供方。0 分钟表示该路由不压缩；未匹配的路由从不压缩。",
			provider: "提供方",
			model: "模型",
			minutes: "空闲分钟数",
			anyProvider: "任意提供方",
			anyModel: "任意模型",
			empty: "还没有规则，因此不会压缩任何会话。",
			add: "添加规则",
			remove: "移除",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些规则，已保留供你修改。",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			unavailableOption: "不可用",
			catalogLoading: "正在加载可用模型…",
			catalogFailed: "无法加载可用模型。",
			catalogEmpty: "当前没有可用模型。",
			retry: "重试",
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
		 * Provider choices: every catalog provider, then a saved provider the
		 * catalog no longer offers so a stale rule is never silently rewritten.
		 * @param groups - provider groups from the host model catalog.
		 * @param current - the row's saved provider id.
		 */
		function providerChoices(groups, current) {
			const choices = [];
			const seen = new Set();
			for (const group of groups) {
				if (seen.has(group.id)) continue;
				seen.add(group.id);
				choices.push({ value: group.id, label: group.name || group.id, unavailable: false });
			}
			const saved = current.trim();
			if (saved && !seen.has(saved)) choices.push({ value: saved, label: saved, unavailable: true });
			return choices;
		}

		/**
		 * Model choices: one provider's models, the union across providers for
		 * "any provider", then a saved model the catalog no longer offers.
		 * @param groups - provider groups from the host model catalog.
		 * @param provider - the row's selected provider id; empty means any.
		 * @param current - the row's saved model id.
		 */
		function modelChoices(groups, provider, current) {
			const selected = provider.trim();
			const choices = [];
			const seen = new Set();
			for (const group of groups) {
				if (selected && group.id !== selected) continue;
				for (const model of group.models) {
					if (seen.has(model.id)) continue;
					seen.add(model.id);
					choices.push({ value: model.id, label: model.name || model.id, unavailable: false });
				}
			}
			const saved = current.trim();
			if (saved && !seen.has(saved)) choices.push({ value: saved, label: saved, unavailable: true });
			return choices;
		}

		/**
		 * Load the host model catalog into a small render state.
		 * @param remote - the client remote service (`remote.session.modelCatalog`).
		 */
		async function loadCatalog(remote) {
			try {
				const response = await remote.session.modelCatalog();
				if (!response.ok) return { status: "error", error: response.error.code + ": " + response.error.message };
				return { status: "ready", groups: response.value.groups };
			} catch (error) {
				return { status: "error", error: error instanceof Error ? error.message : String(error) };
			}
		}

		/**
		 * Fetch the catalog once and expose a retry trigger.
		 * @param remote - the client remote service.
		 */
		function useCatalog(remote) {
			const [catalog, setCatalog] = React.useState({ status: "loading" });
			const [attempt, setAttempt] = React.useState(0);
			React.useEffect(() => {
				let cancelled = false;
				setCatalog({ status: "loading" });
				loadCatalog(remote).then((next) => {
					if (!cancelled) setCatalog(next);
				});
				return () => { cancelled = true; };
			}, [attempt]);
			return [catalog, () => setAttempt((value) => value + 1)];
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
		const selectStyle = { ...inputStyle, appearance: "auto" };
		const rowStyle = { display: "grid", gridTemplateColumns: "1fr 1fr 110px auto", gap: 8, alignItems: "center" };
		const noteStyle = { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" };
		const errorStyle = { ...noteStyle, color: "var(--dsw-alias-state-error-primary)" };

		/**
		 * The row's page: its one-liner, or the editable rules table whose
		 * provider and model cells only offer values from the host catalog.
		 * @param props - `view`, locale reader `t`, host `form`, and `remote`.
		 */
		function RulesPage(props) {
			const { t, view, form, remote } = props;
			const [draft, setDraft] = React.useState(null);
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			const [catalog, retry] = useCatalog(remote);
			if (view === "summary") return t("summary");
			const state = form && form.state;
			if (!state || state.status !== "ready") return h("p", { style: noteStyle }, t("unavailable"));
			if (catalog.status === "loading") return h("p", { style: noteStyle }, t("catalogLoading"));
			if (catalog.status === "error") {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
					h("p", { style: errorStyle, role: "alert" }, t("catalogFailed") + " " + catalog.error),
					h(Button, { variant: "outline", size: "sm", onClick: retry }, t("retry")));
			}

			const groups = catalog.groups;
			const rows = draft ?? draftFrom(state.value);
			const errors = draft ? draftErrors(draft) : [];
			const locked = !state.writable;
			const change = (next) => {
				setFailed(false);
				setDraft(next);
			};
			const edit = (index, field, value) => change(rows.map((row, i) => {
				if (i !== index) return row;
				if (field !== "provider") return { ...row, [field]: value };
				const keepModel = modelChoices(groups, value, "").some((choice) => choice.value === row.model.trim());
				return { ...row, provider: value, ...(keepModel ? {} : { model: "" }) };
			}));
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
			const options = (choices) => choices.map((choice) => h("option", { key: choice.value, value: choice.value },
				choice.unavailable ? choice.label + " (" + t("unavailableOption") + ")" : choice.label));
			const select = (index, name, choices, anyLabel) => h("select", {
				value: rows[index][name].trim(),
				"aria-label": t(name),
				disabled: locked,
				style: selectStyle,
				onChange: (event) => edit(index, name, event.target.value),
			},
				h("option", { value: "" }, anyLabel),
				options(choices));
			const minutes = (index) => h("input", {
				value: rows[index].minutes,
				inputMode: "decimal",
				"aria-label": t("minutes"),
				disabled: locked,
				style: inputStyle,
				onChange: (event) => edit(index, "minutes", event.target.value),
			});

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				h("p", { style: noteStyle }, t("hint")),
				groups.length === 0 ? h("p", { style: noteStyle }, t("catalogEmpty")) : null,
				rows.length === 0 ? h("p", { style: noteStyle }, t("empty")) : h("div", { style: rowStyle },
					h("span", { style: noteStyle }, t("provider")),
					h("span", { style: noteStyle }, t("model")),
					h("span", { style: noteStyle }, t("minutes")),
					h("span")),
				rows.map((row, index) => h("div", { key: index, style: rowStyle },
					select(index, "provider", providerChoices(groups, row.provider), t("anyProvider")),
					select(index, "model", modelChoices(groups, row.provider, row.model), t("anyModel")),
					minutes(index),
					h(Button, { variant: "outline", size: "sm", disabled: locked, onClick: () => change(rows.filter((__, i) => i !== index)) }, t("remove")))),
				errors.map((message) => h("p", { key: message, style: errorStyle, role: "alert" }, message)),
				failed ? h("p", { style: errorStyle, role: "alert" }, t("saveFailed")) : null,
				locked ? h("p", { style: noteStyle }, t("readOnly")) : null,
				h("div", { style: { display: "flex", gap: 8 } },
					h(Button, { variant: "outline", size: "sm", disabled: locked, onClick: () => change([...rows, { provider: "", model: "", minutes: "10" }]) }, t("add")),
					h(Button, { variant: "primary", size: "sm", disabled: locked || !draft || errors.length > 0 || saving, onClick: save }, saving ? t("saving") : t("save"))));
		}

		/** Required services (cordis fiber inject); `remote.session` carries the host model catalog. */
		const inject = ["slots", "locale", "remote", "remote.session"];

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
			}, (props) => h(RulesPage, { ...props, remote: ctx.remote })));
		}

		module.exports.name = "dsh-autocompact-client";
		module.exports.NS = NS;
		module.exports.KEY = KEY;
		module.exports.inject = inject;
		module.exports.apply = apply;
		module.exports.draftFrom = draftFrom;
		module.exports.draftErrors = draftErrors;
		module.exports.providerChoices = providerChoices;
		module.exports.modelChoices = modelChoices;
		module.exports.loadCatalog = loadCatalog;
		module.exports.rulesToOps = rulesToOps;
		module.exports.RulesPage = RulesPage;
		return module.exports;
	},
});

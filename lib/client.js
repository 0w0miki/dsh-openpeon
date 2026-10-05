window.__ModuleLoader__.load({
	id: "dsh-openpeon",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/cesp.ts
		/** All categories, in display order. */
		const NOTIFICATION_CATEGORIES = [
			"session-start",
			"task-acknowledge",
			"task-complete",
			"task-error",
			"input-required",
			"session-end"
		];
		/** Persisted id → the CESP category a pack manifest files it under. */
		const CESP_OF = {
			"session-start": "session.start",
			"task-acknowledge": "task.acknowledge",
			"task-complete": "task.complete",
			"task-error": "task.error",
			"input-required": "input.required",
			"session-end": "session.end"
		};
		//#endregion
		//#region src/client/notification-store.ts
		/**
		* Client-side notification preferences, persisted to localStorage.
		*
		* This is a UI-preference store (like the settings shell store), not business
		* data: it records which task-stage sounds the human has opted into and the
		* master volume. Persistence is the snapshot store's built-in localStorage
		* driver, so a reload restores the human's choices.
		*/
		const DEFAULT_CATEGORIES = {
			"session-start": false,
			"task-acknowledge": false,
			"task-complete": true,
			"task-error": true,
			"input-required": true,
			"session-end": false
		};
		function initSettings() {
			return {
				enabled: false,
				categories: { ...DEFAULT_CATEGORIES },
				volume: .8
			};
		}
		/**
		* Declare the notification preferences store with localStorage persistence.
		* @returns one root-scoped store handle.
		*/
		function createNotificationSettingsStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: initSettings,
				persist: "dsh-notifications",
				actions: {
					setEnabled: (d, enabled) => {
						d.enabled = enabled;
					},
					setCategory: (d, category, enabled) => {
						d.categories[category] = enabled;
					},
					setVolume: (d, volume) => {
						d.volume = Math.max(0, Math.min(1, volume));
					}
				}
			});
		}
		//#endregion
		//#region src/client/pack-store.ts
		/**
		* Client-side pack catalogue: what the registry offers, what is installed, and
		* which pack is selected.
		*
		* The state lives in the browser because it is presentation state (filters,
		* in-flight operations, the last error). The authoritative facts — installed
		* packs and the selection — live on the Host, which owns the files; every
		* action here round-trips through its endpoints and then re-reads the state,
		* so two windows cannot drift.
		*/
		/** Registry route base, matching the Host's prefix. */
		const BASE = "/openpeon";
		/** Map one installed pack from the Host payload. */
		function installedOf(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const raw = value;
			if (typeof raw.name !== "string" || typeof raw.displayName !== "string") return void 0;
			return {
				name: raw.name,
				displayName: raw.displayName,
				version: typeof raw.version === "string" ? raw.version : "0.0.0",
				sourceVersion: typeof raw.sourceVersion === "string" ? raw.sourceVersion : typeof raw.version === "string" ? raw.version : "0.0.0",
				manifestSha256: typeof raw.manifestSha256 === "string" ? raw.manifestSha256 : "",
				license: typeof raw.license === "string" ? raw.license : "",
				language: typeof raw.language === "string" ? raw.language : "",
				installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
				soundCount: typeof raw.soundCount === "number" ? raw.soundCount : 0,
				totalSizeBytes: typeof raw.totalSizeBytes === "number" ? raw.totalSizeBytes : 0,
				categories: typeof raw.categories === "object" && raw.categories !== null ? raw.categories : {},
				preview: Array.isArray(raw.preview) ? raw.preview.filter((item) => typeof item === "string") : []
			};
		}
		/** Map one registry entry from the Host payload. */
		function registryPackOf(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const raw = value;
			if (typeof raw.name !== "string" || typeof raw.displayName !== "string") return void 0;
			const trustTier = raw.trustTier === "official" || raw.trustTier === "verified" ? raw.trustTier : "community";
			const size = raw.totalSizeBytes;
			return {
				name: raw.name,
				displayName: raw.displayName,
				version: typeof raw.version === "string" ? raw.version : "0.0.0",
				description: typeof raw.description === "string" ? raw.description : "",
				authorName: typeof raw.authorName === "string" ? raw.authorName : "",
				authorGithub: typeof raw.authorGithub === "string" ? raw.authorGithub : "",
				trustTier,
				categories: Array.isArray(raw.categories) ? raw.categories.filter((item) => typeof item === "string") : [],
				language: typeof raw.language === "string" ? raw.language : "",
				license: typeof raw.license === "string" ? raw.license : "",
				soundCount: typeof raw.soundCount === "number" ? raw.soundCount : 0,
				...typeof size === "number" ? { totalSizeBytes: size } : {},
				tags: Array.isArray(raw.tags) ? raw.tags.filter((item) => typeof item === "string") : [],
				...typeof raw.quality === "string" ? { quality: raw.quality } : {},
				...typeof raw.updated === "string" ? { updated: raw.updated } : {},
				sourceRepo: typeof raw.sourceRepo === "string" ? raw.sourceRepo : "",
				...typeof raw.manifestSha256 === "string" ? { manifestSha256: raw.manifestSha256 } : {}
			};
		}
		/**
		* Whether the registry now offers content other than what is installed.
		*
		* The registry's `manifest_sha256` digests the pack manifest at the ref it
		* pins, and the install records the digest it verified — so comparing digests
		* answers the question directly. Version strings only decide it when the
		* registry carries no digest: a pack's own `version` field regularly lags the
		* registry's, which made fresh installs look permanently updatable.
		* @param installed - the installed pack record.
		* @param latest - the registry entry for the same name, when the catalogue has it.
		* @returns true when an update is available.
		*/
		function hasUpdate(installed, latest) {
			if (latest.manifestSha256 !== void 0 && installed.manifestSha256 !== "") return latest.manifestSha256 !== installed.manifestSha256;
			return latest.version !== installed.sourceVersion;
		}
		/**
		* Build the catalogue store and its actions.
		* @param player - the shared sound player, used for previews.
		* @param fetchImpl - fetch implementation; injectable for tests.
		* @returns the store bound to `usePacks` plus its actions.
		*/
		function createPackStore(player, fetchImpl = fetch) {
			const hooks = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				installedStatus: "loading",
				registryStatus: "loading",
				activePack: null,
				packs: [],
				registry: [],
				registryFetchedAt: null,
				busy: null,
				error: null
			}, { flush: "raf" });
			/** Send one mutating request, surfacing the Host's message on failure. */
			const post = async (path, body) => {
				const response = await fetchImpl(`${BASE}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${String(response.status)}`);
			};
			/**
			* Read the local facts. Settles on its own status, so the installed list
			* renders without waiting for the catalogue.
			*/
			const loadState = async () => {
				try {
					const response = await fetchImpl(`${BASE}/state`);
					if (!response.ok) throw new Error(`state request failed: HTTP ${String(response.status)}`);
					const payload = await response.json();
					const packs = Array.isArray(payload.packs) ? payload.packs.map(installedOf).filter((pack) => pack !== void 0) : [];
					const registry = payload.registry;
					hooks.set({
						...hooks.getSnapshot(),
						installedStatus: "ready",
						activePack: typeof payload.activePack === "string" ? payload.activePack : null,
						packs,
						...typeof registry?.fetchedAt === "string" ? { registryFetchedAt: registry.fetchedAt } : {}
					});
				} catch (error) {
					hooks.set({
						...hooks.getSnapshot(),
						installedStatus: "error",
						error: error instanceof Error ? error.message : String(error)
					});
				}
			};
			/** Read the online catalogue. Independently of {@link loadState}. */
			const loadRegistry = async (refresh) => {
				hooks.set({
					...hooks.getSnapshot(),
					registryStatus: "loading"
				});
				try {
					const response = await fetchImpl(`${BASE}/registry${refresh ? "?refresh=1" : ""}`);
					if (!response.ok) throw new Error(`registry request failed: HTTP ${String(response.status)}`);
					const payload = await response.json();
					const registry = Array.isArray(payload.packs) ? payload.packs.map(registryPackOf).filter((pack) => pack !== void 0) : [];
					hooks.set({
						...hooks.getSnapshot(),
						registryStatus: "ready",
						registry,
						registryFetchedAt: typeof payload.fetchedAt === "string" ? payload.fetchedAt : null
					});
				} catch (error) {
					hooks.set({
						...hooks.getSnapshot(),
						registryStatus: "error",
						error: error instanceof Error ? error.message : String(error)
					});
				}
			};
			/** Collapse a failure into the store's error slot instead of throwing at the UI. */
			const guard = async (busy, action) => {
				hooks.set({
					...hooks.getSnapshot(),
					busy,
					error: null
				});
				try {
					await action();
				} catch (error) {
					hooks.set({
						...hooks.getSnapshot(),
						busy: null,
						error: error instanceof Error ? error.message : String(error)
					});
					return;
				}
				hooks.set({
					...hooks.getSnapshot(),
					busy: null
				});
			};
			return {
				hooks,
				async load() {
					hooks.set({
						...hooks.getSnapshot(),
						error: null
					});
					await Promise.all([loadState(), loadRegistry(false)]);
				},
				async refresh() {
					await guard(null, async () => {
						await Promise.all([loadRegistry(true), loadState()]);
					});
				},
				async install(name) {
					await guard(name, async () => {
						await post("/install", { name });
						await loadState();
					});
				},
				async remove(name) {
					await guard(name, async () => {
						await post("/remove", { name });
						await loadState();
					});
				},
				async select(name) {
					await guard(null, async () => {
						await post("/active", { pack: name });
						await loadState();
					});
				},
				preview(pack, file) {
					player.playUrl(`${BASE}/preview/${encodeURIComponent(pack)}/${file.split("/").map(encodeURIComponent).join("/")}`, .8);
				}
			};
		}
		//#endregion
		//#region \0dsh-css:/Users/xzong/coding/dsh-plugins/dsh-openpeon/src/client/PackPicker.module.css.mjs
		const css$2 = ".M2TpfW_root{flex-direction:column;gap:20px;margin-top:4px;display:flex}.M2TpfW_installed,.M2TpfW_browse{flex-direction:column;gap:6px;display:flex}.M2TpfW_subhead{align-items:center;gap:8px;display:flex}.M2TpfW_subtitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}.M2TpfW_count{color:var(--dsw-alias-label-tertiary);margin-right:auto;font-size:12px}.M2TpfW_packRow{border-top:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:16px;padding:10px 0;display:flex}.M2TpfW_packText{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}.M2TpfW_packName{color:var(--dsw-alias-label-primary);flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;display:flex}.M2TpfW_version{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px}.M2TpfW_packMeta{color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px;overflow:hidden}.M2TpfW_packDescription{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}.M2TpfW_packActions{flex-shrink:0;align-items:center;gap:6px;display:flex}.M2TpfW_search{margin:2px 0 6px}.M2TpfW_empty{color:var(--dsw-alias-label-tertiary);padding:6px 0;font-size:13px}.M2TpfW_error{border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover);padding:8px 10px;font-size:13px;line-height:18px}";
		const tagId$2 = "dsh-openpeon//Users/xzong/coding/dsh-plugins/dsh-openpeon/src/client/PackPicker.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-openpeon";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var PackPicker_module_css_default = {
			"browse": "M2TpfW_browse",
			"count": "M2TpfW_count",
			"empty": "M2TpfW_empty",
			"error": "M2TpfW_error",
			"installed": "M2TpfW_installed",
			"packActions": "M2TpfW_packActions",
			"packDescription": "M2TpfW_packDescription",
			"packMeta": "M2TpfW_packMeta",
			"packName": "M2TpfW_packName",
			"packRow": "M2TpfW_packRow",
			"packText": "M2TpfW_packText",
			"root": "M2TpfW_root",
			"search": "M2TpfW_search",
			"subhead": "M2TpfW_subhead",
			"subtitle": "M2TpfW_subtitle",
			"version": "M2TpfW_version"
		};
		//#endregion
		//#region src/client/PackPicker.tsx
		/**
		* Pack catalogue UI: the installed packs, the registry browser, and the
		* selection. Rendered inside the plugin's own settings page.
		*
		* All copy arrives through `t`; every fact about a pack (author, license,
		* trust tier, size, quality, update availability) is shown so a human can
		* judge a third-party download before installing it.
		*/
		/** How many catalogue rows render at once; search narrows the rest. */
		const MAX_ROWS = 60;
		/** Translate a registry trust tier into a tag tone. */
		function trustTone(tier) {
			if (tier === "official") return "success";
			if (tier === "verified") return "info";
			return "neutral";
		}
		/** Translate an automated quality tier into a tag tone. */
		function qualityTone(quality) {
			if (quality === "gold") return "success";
			if (quality === "silver") return "info";
			if (quality === "flagged") return "danger";
			return "quiet";
		}
		/** Human-readable byte size. */
		function sizeText(bytes) {
			if (bytes === void 0 || bytes <= 0) return "";
			if (bytes < 1024) return `${String(bytes)} B`;
			if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KiB`;
			return `${(bytes / 1048576).toFixed(1)} MiB`;
		}
		/**
		* Render the pack catalogue.
		* @param props - catalogue state, copy, and actions from the settings page.
		* @returns the catalogue element tree.
		*/
		function PackPicker({ state, t, onInstall, onRemove, onSelect, onPreview, onRefresh }) {
			const [query, setQuery] = (0, react.useState)("");
			const installedNames = (0, react.useMemo)(() => new Set(state.packs.map((pack) => pack.name)), [state.packs]);
			const matches = (0, react.useMemo)(() => {
				const needle = query.trim().toLowerCase();
				const available = state.registry.filter((pack) => !installedNames.has(pack.name));
				if (needle === "") return available;
				return available.filter((pack) => [
					pack.name,
					pack.displayName,
					pack.description,
					pack.language,
					pack.authorName,
					pack.authorGithub,
					...pack.tags,
					...pack.categories
				].some((field) => field.toLowerCase().includes(needle)));
			}, [
				query,
				state.registry,
				installedNames
			]);
			const shown = matches.slice(0, MAX_ROWS);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: PackPicker_module_css_default.root,
				children: [
					state.error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: PackPicker_module_css_default.error,
						role: "alert",
						children: state.error
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: PackPicker_module_css_default.installed,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: PackPicker_module_css_default.subhead,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: PackPicker_module_css_default.subtitle,
								children: t("packs.installed")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: PackPicker_module_css_default.count,
								children: state.packs.length === 0 ? t("packs.none") : String(state.packs.length)
							})]
						}), state.installedStatus === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: PackPicker_module_css_default.empty,
							children: t("packs.loading")
						}) : state.installedStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: PackPicker_module_css_default.empty,
							children: t("packs.installed.failed")
						}) : state.packs.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: PackPicker_module_css_default.empty,
							children: t("packs.installed.empty")
						}) : state.packs.map((pack) => {
							const latest = state.registry.find((candidate) => candidate.name === pack.name);
							const outdated = latest !== void 0 && hasUpdate(pack, latest);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: PackPicker_module_css_default.packRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: PackPicker_module_css_default.packText,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: PackPicker_module_css_default.packName,
										children: [
											pack.displayName,
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: PackPicker_module_css_default.version,
												children: pack.sourceVersion
											}),
											state.activePack === pack.name ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
												tone: "solid",
												children: t("packs.active")
											}) : null,
											outdated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
												tone: "info",
												children: t("packs.update")
											}) : null
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: PackPicker_module_css_default.packMeta,
										children: [
											pack.license,
											pack.language,
											sizeText(pack.totalSizeBytes)
										].filter(Boolean).join(" · ")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: PackPicker_module_css_default.packActions,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											size: "sm",
											variant: "ghost",
											disabled: pack.preview.length === 0,
											onClick: () => {
												onPreview(pack);
											},
											children: t("packs.preview")
										}),
										state.activePack === pack.name ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											size: "sm",
											variant: "outline",
											disabled: state.busy !== null,
											onClick: () => {
												onSelect(null);
											},
											children: t("packs.deselect")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											size: "sm",
											variant: "primary",
											disabled: state.busy !== null,
											onClick: () => {
												onSelect(pack.name);
											},
											children: t("packs.select")
										}),
										outdated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											size: "sm",
											variant: "outline",
											disabled: state.busy !== null,
											onClick: () => {
												if (latest !== void 0) onInstall(latest);
											},
											children: t("packs.update.action")
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											size: "sm",
											variant: "ghost",
											disabled: state.busy === pack.name,
											onClick: () => {
												onRemove(pack);
											},
											children: state.busy === pack.name ? t("packs.working") : t("packs.remove")
										})
									]
								})]
							}, pack.name);
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: PackPicker_module_css_default.browse,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: PackPicker_module_css_default.subhead,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: PackPicker_module_css_default.subtitle,
										children: t("packs.browse")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: PackPicker_module_css_default.count,
										children: state.registryStatus === "loading" ? t("packs.registry.loading") : state.registryStatus === "error" ? t("packs.registry.unavailable") : t("packs.registry.count").replace("{n}", String(state.registry.length))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "ghost",
										disabled: state.busy !== null || state.registryStatus === "loading",
										onClick: onRefresh,
										children: t("packs.refresh")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								className: PackPicker_module_css_default.search ?? "",
								type: "search",
								value: query,
								placeholder: t("packs.search"),
								"aria-label": t("packs.search"),
								disabled: state.registryStatus !== "ready",
								onChange: (event) => {
									setQuery(event.target.value);
								}
							}),
							state.registryStatus === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: PackPicker_module_css_default.empty,
								children: t("packs.registry.loading")
							}) : state.registryStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: PackPicker_module_css_default.empty,
								children: t("packs.registry.failed")
							}) : shown.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: PackPicker_module_css_default.empty,
								children: t("packs.browse.empty")
							}) : shown.map((pack) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: PackPicker_module_css_default.packRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: PackPicker_module_css_default.packText,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: PackPicker_module_css_default.packName,
											children: [
												pack.displayName,
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: PackPicker_module_css_default.version,
													children: pack.version
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
													tone: trustTone(pack.trustTier),
													children: t(`packs.tier.${pack.trustTier}`)
												}),
												pack.quality !== void 0 && pack.quality !== "unreviewed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
													tone: qualityTone(pack.quality),
													children: pack.quality
												}) : null
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: PackPicker_module_css_default.packMeta,
											children: [
												pack.authorName,
												pack.license,
												pack.language,
												t("packs.sounds").replace("{n}", String(pack.soundCount)),
												sizeText(pack.totalSizeBytes),
												pack.updated ?? ""
											].filter(Boolean).join(" · ")
										}),
										pack.description !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: PackPicker_module_css_default.packDescription,
											children: pack.description
										}) : null
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: PackPicker_module_css_default.packActions,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "outline",
										disabled: state.busy !== null,
										onClick: () => {
											onInstall(pack);
										},
										children: state.busy === pack.name ? t("packs.working") : t("packs.install")
									})
								})]
							}, pack.name)),
							matches.length > shown.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: PackPicker_module_css_default.count,
								children: t("packs.more").replace("{n}", String(matches.length - shown.length))
							}) : null
						]
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/xzong/coding/dsh-plugins/dsh-openpeon/src/client/NotificationSettingsSection.module.css.mjs
		const css$1 = ".nSU5dG_section{flex-direction:column;gap:12px;padding:4px 0;display:flex}.nSU5dG_head{justify-content:space-between;align-items:center;gap:16px;display:flex}.nSU5dG_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}.nSU5dG_description{color:var(--dsw-alias-label-tertiary);margin-top:2px;font-size:13px;line-height:18px}.nSU5dG_body{flex-direction:column;gap:12px;padding-left:4px;display:flex}.nSU5dG_volume{align-items:center;gap:12px;display:flex}.nSU5dG_volumeLabel{color:var(--dsw-alias-label-secondary);min-width:48px;font-size:13px}.nSU5dG_volumeValue{color:var(--dsw-alias-label-primary);text-align:right;min-width:36px;font-size:12px}.nSU5dG_slider{accent-color:var(--dsw-alias-brand-primary)}.nSU5dG_categories{flex-direction:column;gap:4px;display:flex}.nSU5dG_categoryRow{justify-content:space-between;align-items:center;gap:16px;padding:2px 0;display:flex}.nSU5dG_categoryLabel{color:var(--dsw-alias-label-primary);font-size:13px}.nSU5dG_categoryActions{align-items:center;gap:8px;display:flex}.nSU5dG_hint{color:var(--dsw-alias-label-tertiary);padding-bottom:2px;font-size:12px;line-height:17px}.nSU5dG_packs{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:4px;padding-top:12px;display:flex}";
		const tagId$1 = "dsh-openpeon//Users/xzong/coding/dsh-plugins/dsh-openpeon/src/client/NotificationSettingsSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-openpeon";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var NotificationSettingsSection_module_css_default = {
			"body": "nSU5dG_body",
			"categories": "nSU5dG_categories",
			"categoryActions": "nSU5dG_categoryActions",
			"categoryLabel": "nSU5dG_categoryLabel",
			"categoryRow": "nSU5dG_categoryRow",
			"description": "nSU5dG_description",
			"head": "nSU5dG_head",
			"hint": "nSU5dG_hint",
			"packs": "nSU5dG_packs",
			"section": "nSU5dG_section",
			"slider": "nSU5dG_slider",
			"title": "nSU5dG_title",
			"volume": "nSU5dG_volume",
			"volumeLabel": "nSU5dG_volumeLabel",
			"volumeValue": "nSU5dG_volumeValue"
		};
		//#endregion
		//#region src/client/NotificationSettingsSection.tsx
		/** The OpenPeon settings page: task-stage alerts, the sound pack, and the toast. */
		/** Locale key per category, typed so `t()` resolves at compile time. */
		const CATEGORY_KEY = {
			"session-start": "category.session-start",
			"task-acknowledge": "category.task-acknowledge",
			"task-complete": "category.task-complete",
			"task-error": "category.task-error",
			"input-required": "category.input-required",
			"session-end": "category.session-end"
		};
		/**
		* Render the OpenPeon page: a master switch, per-category toggles, a volume
		* slider, and the sound-pack catalogue. Category and volume controls only
		* render when alerts are enabled, so the page collapses to the switch and the
		* pack catalogue when the human opts out.
		* @param props - composed settings-section slot props.
		* @returns the preference and catalogue page.
		*/
		function NotificationSettingsSection(props) {
			const { useNotifications, usePacks, t, setEnabled, setCategory, setVolume, previewCategory, loadPacks, refreshPacks, installPack, removePack, selectPack, previewPack } = props;
			const settings = useNotifications((state) => state);
			const packs = usePacks((state) => state);
			const [volumeDraft, setVolumeDraft] = (0, react.useState)(settings.volume);
			const enabled = settings.enabled;
			const auditionable = packs.activePack !== null;
			(0, react.useEffect)(() => {
				loadPacks();
			}, [loadPacks]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: NotificationSettingsSection_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: NotificationSettingsSection_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: NotificationSettingsSection_module_css_default.title,
							children: t("title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: NotificationSettingsSection_module_css_default.description,
							children: t("master.description")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: enabled,
							label: t("master.label"),
							onChange: (next) => {
								setEnabled(next);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: NotificationSettingsSection_module_css_default.body,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: NotificationSettingsSection_module_css_default.volume,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: NotificationSettingsSection_module_css_default.volumeLabel,
									children: t("volume")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "range",
									min: "0",
									max: "100",
									step: "1",
									className: NotificationSettingsSection_module_css_default.slider,
									value: Math.round(volumeDraft * 100),
									"aria-label": t("volume"),
									onChange: (event) => {
										const next = Number(event.target.value) / 100;
										setVolumeDraft(next);
										setVolume(next);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: NotificationSettingsSection_module_css_default.volumeValue,
									children: [Math.round(volumeDraft * 100), "%"]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: NotificationSettingsSection_module_css_default.categories,
							children: [!auditionable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: NotificationSettingsSection_module_css_default.hint,
								children: t("category.preview.none")
							}) : null, NOTIFICATION_CATEGORIES.map((category) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: NotificationSettingsSection_module_css_default.categoryRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: NotificationSettingsSection_module_css_default.categoryLabel,
									children: t(CATEGORY_KEY[category])
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: NotificationSettingsSection_module_css_default.categoryActions,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "ghost",
										disabled: !auditionable,
										"aria-label": `${t("category.preview")} ${t(CATEGORY_KEY[category])}`,
										onClick: () => {
											previewCategory(category);
										},
										children: t("category.preview")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
										checked: settings.categories[category],
										label: t(CATEGORY_KEY[category]),
										onChange: (next) => {
											setCategory(category, next);
										}
									})]
								})]
							}, category))]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: NotificationSettingsSection_module_css_default.packs,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: NotificationSettingsSection_module_css_default.title,
								children: t("packs.title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: NotificationSettingsSection_module_css_default.description,
								children: t("packs.subtitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PackPicker, {
								state: packs,
								t,
								onInstall: (pack) => {
									installPack(pack.name);
								},
								onRemove: (pack) => {
									removePack(pack.name);
								},
								onSelect: (name) => {
									selectPack(name);
								},
								onPreview: (pack) => {
									const file = pack.preview[0];
									if (file !== void 0) previewPack({
										...pack,
										preview: [file]
									});
								},
								onRefresh: () => {
									refreshPacks();
								}
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/xzong/coding/dsh-plugins/dsh-openpeon/src/client/ToastContainer.module.css.mjs
		const css = ".SAYFCW_wrap{z-index:1000;pointer-events:none;position:fixed;bottom:24px;left:50%;transform:translate(-50%)}.SAYFCW_wrap>*{pointer-events:auto}";
		const tagId = "dsh-openpeon//Users/xzong/coding/dsh-plugins/dsh-openpeon/src/client/ToastContainer.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-openpeon";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ToastContainer_module_css_default = { "wrap": "SAYFCW_wrap" };
		//#endregion
		//#region src/client/ToastContainer.tsx
		/** Renders the active toast banner through the shared `Toast` primitive. */
		/**
		* Mount one toast at the page end. It renders nothing when no toast is active,
		* so the human only sees a banner when a notification actually fires.
		* @param props - composed shell overlay slot props.
		* @returns the toast element or null.
		*/
		function ToastContainer({ useToast, clearToast }) {
			const item = useToast((state) => state);
			if (item === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: ToastContainer_module_css_default.wrap,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
					text: item.text,
					...item.tone !== void 0 ? { tone: item.tone } : {},
					onDone: clearToast
				})
			});
		}
		//#endregion
		//#region src/client/sound-player.ts
		/**
		* Audio player. Asks the Host for one sound of the selected pack and decodes
		* it with `AudioContext.decodeAudioData` — real audio files on disk, not
		* real-time oscillator synthesis.
		*
		* The AudioContext is created lazily and resumed on first user gesture (a
		* browser policy requirement: audio must start after a user interaction). The
		* first request auto-resumes it; if that fails, later requests are silent
		* rather than queuing behind an unsuspended context.
		*
		* One queue serves both the notification sounds (addressed by category, chosen
		* by the Host from the selected pack) and previews (addressed by explicit URL),
		* so an alert is never dropped because a preview is in flight. The queue orders
		* *fetching and starting*; it does not wait for a sound to finish, so two
		* requests that arrive close together do overlap.
		*/
		/**
		* Plays pack audio through one lazily created AudioContext.
		*
		* Requests are queued and started in order — nothing is dropped, and a later
		* request never cuts an earlier one off — but a request is considered done once
		* its source is scheduled, so playback of consecutive requests overlaps rather
		* than waiting for the previous sound to end. Every failure is contained: a
		* sound that cannot be fetched or decoded leaves the listener that requested it
		* unaffected.
		*/
		var SoundPlayer = class SoundPlayer {
			audio;
			pending = [];
			flushing = false;
			/** Base URL of the Host-served pack routes. */
			static soundBase = "/openpeon";
			/**
			* Request the sound of one task-stage category. The Host picks a file from
			* the selected pack, so the client never needs to know which pack is active.
			* @param category - task-stage category.
			* @param volume - linear gain applied to this play, 0 through 1.
			*/
			play(category, volume) {
				this.enqueue(`${SoundPlayer.soundBase}/sound/${CESP_OF[category]}`, volume);
			}
			/**
			* Request one explicit Host-served audio URL, for pack previews.
			* @param url - absolute or root-relative URL under the Host.
			* @param volume - linear gain applied to this play, 0 through 1.
			*/
			playUrl(url, volume) {
				this.enqueue(url, volume);
			}
			/** Ensure the AudioContext is resumed (call from a user gesture). */
			resume() {
				if (this.audio === void 0) return;
				if (this.audio.state === "suspended") this.audio.resume().catch(() => {});
			}
			/** Queue one request behind whatever is already being prepared. */
			enqueue(url, volume) {
				this.pending.push({
					url,
					volume
				});
				this.flush();
			}
			/**
			* Prepare the next queued request. `flushing` guards preparation, not
			* playback: `playOne` resolves as soon as its source is scheduled, so the
			* next request begins fetching while the previous sound is still ringing.
			*/
			flush() {
				if (this.flushing) return;
				const next = this.pending.shift();
				if (next === void 0) return;
				this.flushing = true;
				this.playOne(next).finally(() => {
					this.flushing = false;
					this.flush();
				});
			}
			async playOne(request) {
				const ctx = this.getContext();
				if (ctx === void 0) return;
				try {
					const response = await fetch(request.url);
					if (!response.ok) return;
					const bytes = await response.arrayBuffer();
					const buffer = await ctx.decodeAudioData(bytes.slice(0));
					const source = ctx.createBufferSource();
					source.buffer = buffer;
					const gain = ctx.createGain();
					gain.gain.value = request.volume;
					source.connect(gain);
					gain.connect(ctx.destination);
					source.start();
				} catch {}
			}
			getContext() {
				if (this.audio === void 0) try {
					this.audio = new AudioContext();
				} catch {
					return;
				}
				if (this.audio.state === "suspended") this.audio.resume().catch(() => {});
				return this.audio;
			}
		};
		//#endregion
		//#region src/client/toast-store.ts
		/**
		* In-app toast state. One transient banner at a time; a second push replaces
		* the first without queuing, so rapid events never stack behind each other.
		* The container component reads this through the standard snapshot store and
		* renders the `Toast` primitive; the Toast's own `onDone` clears the store.
		*/
		let nextId = 1;
		/**
		* One shared toast source; the container binds it through the hooks compartment.
		* @returns the store holding at most one active banner.
		*/
		function createToastStore() {
			return (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null, { flush: "raf" });
		}
		/**
		* Push one toast, replacing any current one.
		* @param store - the toast store to write.
		* @param text - resolved banner copy.
		* @param tone - success styling for a completed action; omitted keeps the default tone.
		*/
		function pushToast(store, text, tone) {
			store.set({
				id: nextId++,
				text,
				tone
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Locale dictionaries for the OpenPeon settings page and toast copy. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"nav": "openpeon",
			"title": "任务提醒",
			"master.label": "启用任务提醒",
			"master.description": "在任务阶段播放语音包中的声音并显示浏览器提醒",
			"volume": "音量",
			"category.session-start": "会话开始",
			"category.task-acknowledge": "开始工作",
			"category.task-complete": "任务完成",
			"category.task-error": "任务失败",
			"category.input-required": "等待输入",
			"category.session-end": "会话结束",
			"category.preview": "试听",
			"category.preview.none": "先安装并选择一个语音包，才能试听各钩子的音效。",
			"toast.start": "会话已开始",
			"toast.acknowledge": "正在处理",
			"toast.complete": "任务已完成",
			"toast.error": "任务出错了",
			"toast.input": "需要你的输入",
			"toast.end": "会话已结束",
			"packs.title": "语音包",
			"packs.subtitle": "语音包来自 OpenPeon 语音包索引（OpenPeon / CESP v1.0），下载后保存在本机。",
			"packs.loading": "正在加载语音包…",
			"packs.installed": "已安装",
			"packs.none": "无",
			"packs.installed.empty": "还没有安装任何语音包。从下面的列表里挑一个下载。",
			"packs.installed.failed": "读取已安装语音包失败 — 重启 dsh 后重试。",
			"packs.active": "当前",
			"packs.select": "使用",
			"packs.deselect": "取消使用",
			"packs.preview": "试听",
			"packs.remove": "删除",
			"packs.install": "下载",
			"packs.working": "处理中…",
			"packs.browse": "可下载",
			"packs.registry.unavailable": "索引暂不可用",
			"packs.registry.loading": "正在加载索引…",
			"packs.registry.failed": "索引加载失败，可点「刷新索引」重试。",
			"packs.registry.count": "索引共 {n} 个语音包",
			"packs.refresh": "刷新索引",
			"packs.search": "搜索名称、作者、标签、语言…",
			"packs.browse.empty": "没有匹配的语音包。",
			"packs.more": "另有 {n} 个匹配项，请细化搜索。",
			"packs.sounds": "{n} 个音频",
			"packs.tier.official": "官方",
			"packs.tier.verified": "已认证",
			"packs.tier.community": "社区",
			"packs.update": "可更新",
			"packs.update.action": "更新"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"nav": "openpeon",
			"title": "Task Alerts",
			"master.label": "Enable task alerts",
			"master.description": "Play sounds from the selected pack and show browser reminders at task stages",
			"volume": "Volume",
			"category.session-start": "Session start",
			"category.task-acknowledge": "Working",
			"category.task-complete": "Task complete",
			"category.task-error": "Task error",
			"category.input-required": "Input required",
			"category.session-end": "Session end",
			"category.preview": "Preview",
			"category.preview.none": "Install and select a sound pack to audition these.",
			"toast.start": "Session started",
			"toast.acknowledge": "Working on it",
			"toast.complete": "Task completed",
			"toast.error": "Task failed",
			"toast.input": "Your input is needed",
			"toast.end": "Session ended",
			"packs.title": "Sound packs",
			"packs.subtitle": "Packs come from the OpenPeon registry (CESP v1.0) and are stored on this machine.",
			"packs.loading": "Loading sound packs…",
			"packs.installed": "Installed",
			"packs.none": "none",
			"packs.installed.empty": "No sound pack installed yet. Download one from the catalogue below.",
			"packs.installed.failed": "Could not read the installed packs — restart dsh and try again.",
			"packs.active": "active",
			"packs.select": "Use",
			"packs.deselect": "Stop using",
			"packs.preview": "Preview",
			"packs.remove": "Delete",
			"packs.install": "Download",
			"packs.working": "Working…",
			"packs.browse": "Available",
			"packs.registry.unavailable": "registry unavailable",
			"packs.registry.loading": "Loading the registry…",
			"packs.registry.failed": "The registry could not be loaded — use Refresh registry to retry.",
			"packs.registry.count": "{n} packs in the registry",
			"packs.refresh": "Refresh registry",
			"packs.search": "Search name, author, tag, language…",
			"packs.browse.empty": "No matching pack.",
			"packs.more": "{n} more matches — refine your search.",
			"packs.sounds": "{n} sounds",
			"packs.tier.official": "official",
			"packs.tier.verified": "verified",
			"packs.tier.community": "community",
			"packs.update": "update",
			"packs.update.action": "Update"
		};
		//#endregion
		//#region src/client/index.ts
		/** Stable namespace for this plugin's dictionaries. */
		const NS = "notifications";
		/** Per-category presentation: the toast copy key and its optional banner tone. */
		const CATEGORY_PRESENTATION = {
			"session-start": { key: "toast.start" },
			"task-acknowledge": { key: "toast.acknowledge" },
			"task-complete": {
				key: "toast.complete",
				tone: "success"
			},
			"task-error": { key: "toast.error" },
			"input-required": { key: "toast.input" },
			"session-end": { key: "toast.end" }
		};
		/** Services required before the notification row and event wiring can register. */
		const inject = [
			"slots",
			"locale",
			"remote"
		];
		/**
		* Show one native browser notification. Silent when permission is unset or
		* denied, or when the platform lacks the API — a broken notification must not
		* break the event listener that triggered it.
		* @param text - resolved banner body.
		*/
		function showNativeNotification(text) {
			if (typeof Notification === "undefined") return;
			if (Notification.permission !== "granted") return;
			try {
				new Notification("DeepSeek Harness", { body: text });
			} catch (error) {
				console.error("native notification failed", error);
			}
		}
		/**
		* Request notification permission on first opt-in. The browser requires a
		* user gesture; the settings toggle is that gesture. Permission state is
		* read at each trigger, so a later grant takes effect without a restart.
		*/
		function requestNotificationPermission() {
			if (typeof Notification === "undefined") return;
			if (Notification.permission === "default") Notification.requestPermission().catch(() => {});
		}
		/**
		* Wire the notification surface: dictionaries, settings row, toast container,
		* and event subscriptions. The trigger closes over the settings snapshot and
		* the sound player, so it reads live preferences at each event.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-notifications: dictionaries");
			const settingsInstance = createNotificationSettingsStore().create();
			const toastStore = createToastStore();
			const soundPlayer = new SoundPlayer();
			const packStore = createPackStore(soundPlayer);
			/** One event trigger: read live preferences, play sound, toast, notify. */
			function trigger(category) {
				const settings = settingsInstance.getSnapshot();
				if (!settings.enabled || !settings.categories[category]) return;
				soundPlayer.play(category, settings.volume);
				const presentation = CATEGORY_PRESENTATION[category];
				const text = t(presentation.key);
				pushToast(toastStore, text, presentation.tone);
				showNativeNotification(text);
			}
			ctx.remote.$on("approval/request", function(_request, next) {
				trigger("input-required");
				return next();
			});
			ctx.remote.$on("user-questions/request", function(_request, next) {
				trigger("input-required");
				return next();
			});
			const announced = /* @__PURE__ */ new Set();
			ctx.remote.$on("api-session/added", (summary) => {
				const id = summary?.sessionId;
				if (id !== void 0) {
					if (announced.has(id)) return;
					announced.add(id);
				}
				trigger("session-start");
			});
			ctx.remote.$on("api-session/removed", (sessionId) => {
				announced.delete(sessionId);
				trigger("session-end");
			});
			ctx.remote.$on("api-session/error", () => {
				trigger("task-error");
			});
			ctx.remote.$on("api-session/status", (_sessionId, running) => {
				trigger(running ? "task-acknowledge" : "task-complete");
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "openpeon",
				order: 100,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({
					hooks: {
						notifications: settingsInstance,
						packs: packStore.hooks
					},
					setEnabled: (enabled) => {
						settingsInstance.actions.setEnabled(enabled);
						if (enabled) requestNotificationPermission();
					},
					setCategory: (category, enabled) => {
						settingsInstance.actions.setCategory(category, enabled);
					},
					setVolume: (volume) => {
						settingsInstance.actions.setVolume(volume);
					},
					previewCategory: (category) => {
						soundPlayer.play(category, settingsInstance.getSnapshot().volume);
					},
					loadPacks: () => {
						packStore.load();
					},
					refreshPacks: () => {
						packStore.refresh();
					},
					installPack: (name) => {
						packStore.install(name);
					},
					removePack: (name) => {
						packStore.remove(name);
					},
					selectPack: (name) => {
						packStore.select(name);
					},
					previewPack: (pack) => {
						const file = pack.preview[0] ?? "";
						if (file !== "") packStore.preview(pack.name, file);
					}
				})
			}, NotificationSettingsSection));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "notifications-toast",
				locale: NS,
				inject: () => ({
					hooks: { toast: toastStore },
					clearToast: () => {
						toastStore.set(null);
					}
				})
			}, ToastContainer));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

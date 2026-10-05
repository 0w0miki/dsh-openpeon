import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { get } from "node:http";
import { get as get$1 } from "node:https";
import { homedir } from "node:os";
//#region src/cesp.ts
/**
* CESP v1.0 vocabulary shared by both halves.
*
* OpenPeon packs declare their sounds under dotted CESP category names
* (`session.start`), while this plugin's own preference store keeps the
* hyphenated ids it has always persisted (`session-start`). This module is the
* single translation table between the two, so the Host can look a pack's
* manifest up by category and the Client can keep its stored keys stable.
*
* CESP defines nine categories; the three DSH exposes no event for
* (`task.progress`, `resource.limit`, `user.spam`) stay unoffered rather than
* shipping a toggle that can never fire.
* @module dsh-openpeon/cesp
*/
/** The CESP v1.0 categories this plugin can drive from a DSH event. */
const CESP_CATEGORIES = [
	"session.start",
	"task.acknowledge",
	"task.complete",
	"task.error",
	"input.required",
	"session.end"
];
/**
* Whether a value is one of the CESP categories this plugin uses.
* @param value - candidate category name.
* @returns true when the Host may look it up in a pack manifest.
*/
function isCesplCategory(value) {
	return CESP_CATEGORIES.includes(value);
}
//#endregion
//#region src/host/http.ts
/**
* The outbound HTTP used for registry and pack downloads.
*
* `node:https` rather than the global `fetch`: on hosts whose IPv6 route to the
* CDN is black-holed, undici pins the first resolved address (AAAA) and dies on
* its connect timeout, while Node's own client applies Happy Eyeballs and
* succeeds. The plugin also needs redirects, a byte cap, and per-request
* timeouts — all simpler here than around `fetch`.
* @module dsh-openpeon/host/http
*/
/** Redirects followed before giving up. */
const MAX_REDIRECTS = 5;
/** Per-request inactivity timeout. */
const REQUEST_TIMEOUT_MS = 3e4;
/** Hard cap on one response body. */
const MAX_RESPONSE_BYTES = 67108864;
/**
* Perform one GET, following redirects.
* @param url - absolute http(s) URL.
* @param options - `accept`, when the caller wants a specific media type.
* @returns the final response.
* @throws on a transport error, a timeout, an oversized body, or too many redirects.
*/
function httpFetch(url, options = {}) {
	return request(url, options, MAX_REDIRECTS);
}
function request(url, options, redirectsLeft) {
	return new Promise((resolve, reject) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			reject(/* @__PURE__ */ new Error(`invalid URL: ${url}`));
			return;
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			reject(/* @__PURE__ */ new Error(`unsupported protocol: ${parsed.protocol}`));
			return;
		}
		const get$2 = parsed.protocol === "https:" ? get$1 : get;
		const requestOptions = { headers: {
			accept: options.accept ?? "*/*",
			"user-agent": "dsh-openpeon"
		} };
		const req = get$2(parsed, requestOptions, (res) => {
			const status = res.statusCode ?? 0;
			const location = res.headers.location;
			if (status >= 300 && status < 400 && location !== void 0 && redirectsLeft > 0) {
				res.resume();
				request(new URL(location, parsed).href, options, redirectsLeft - 1).then(resolve, reject);
				return;
			}
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.byteLength;
				if (size > MAX_RESPONSE_BYTES) {
					req.destroy(/* @__PURE__ */ new Error(`response exceeds ${String(MAX_RESPONSE_BYTES)} bytes`));
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				resolve({
					status,
					ok: status >= 200 && status < 300,
					bytes: new Uint8Array(Buffer.concat(chunks))
				});
			});
		});
		req.setTimeout(REQUEST_TIMEOUT_MS, () => {
			req.destroy(/* @__PURE__ */ new Error(`request timed out after ${String(REQUEST_TIMEOUT_MS)}ms`));
		});
		req.on("error", reject);
	});
}
//#endregion
//#region src/host/paths.ts
/**
* This plugin's own data layout, rooted under the harness home.
*
* Downloaded packs live here rather than inside the profile: the profile's
* `node_modules` entry is a copy that a reinstall or upgrade replaces, and a
* user's sound packs must survive that untouched.
* @module dsh-openpeon/host/paths
*/
/** Directory name of the default harness home under the OS home. */
const DSH_HOME_DIR = ".dsh";
/** Directory name of this plugin's data under the harness home. */
const PLUGIN_DATA_DIR = "dsh-openpeon";
/**
* Resolve the harness home the way the rest of DSH does.
* @param env - environment to read `DSH_HOME` from; empty means unset.
* @returns the configured home, or `<os home>/.dsh`.
*/
function dshHome(env = process.env) {
	const configured = env.DSH_HOME?.trim();
	return configured === void 0 || configured === "" ? join(homedir(), DSH_HOME_DIR) : resolve(configured);
}
/**
* @param env - environment to read `DSH_HOME` from.
* @returns this plugin's data root.
*/
function dataDir(env = process.env) {
	return join(dshHome(env), PLUGIN_DATA_DIR);
}
/**
* @param env - environment to read `DSH_HOME` from.
* @returns the directory holding one subdirectory per installed pack.
*/
function packsDir(env = process.env) {
	return join(dataDir(env), "packs");
}
/**
* @param env - environment to read `DSH_HOME` from.
* @returns the file recording the selected pack.
*/
function statePath(env = process.env) {
	return join(dataDir(env), "state.json");
}
/**
* @param env - environment to read `DSH_HOME` from.
* @returns the cached registry index file.
*/
function registryPath(env = process.env) {
	return join(dataDir(env), "registry.json");
}
/**
* Resolve one child of a root, refusing anything that escapes it.
* Every path segment reaching the filesystem has already passed a registry-name
* or manifest-path check; this is the second, structural line of defence.
* @param root - absolute directory that must contain the result.
* @param segments - relative path segments to join.
* @returns the absolute child path.
* @throws when the joined path is not strictly inside `root`.
*/
function safeJoin(root, ...segments) {
	const target = resolve(root, ...segments);
	if (!target.startsWith(`${root}${sep}`)) throw new Error(`path escapes ${root}: ${segments.join("/")}`);
	return target;
}
//#endregion
//#region src/host/registry.ts
/**
* The PeonPing pack registry: fetching, validating, and caching `index.json`.
*
* The registry is untrusted network input, so every field this plugin acts on
* is validated before use; a malformed entry is dropped rather than allowed to
* decide a filesystem path or a download URL.
* @module dsh-openpeon/host/registry
*/
/** Registry index at the pinned schema version this plugin reads. */
const REGISTRY_URL = "https://cdn.jsdelivr.net/gh/PeonPing/registry@main/index.json";
/** How long a cached index is served before a refresh is attempted. */
const CACHE_TTL_MS = 216e5;
/** Machine-readable pack id, exactly as the registry schema constrains it. */
const PACK_NAME$1 = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** GitHub `owner/repo` as the registry schema constrains it. */
const SOURCE_REPO = /^[\w.-]+\/[\w.-]+$/;
function stringOf$1(value) {
	return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
function stringArrayOf(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function numberOrUndefined(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function trustTierOf(value) {
	return value === "official" || value === "verified" ? value : "community";
}
/**
* Narrow one registry entry to the fields this plugin reads.
* @param value - one element of the index's `packs` array.
* @returns the entry, or undefined when a field this plugin acts on is missing or malformed.
*/
function parsePack(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	const name = stringOf$1(raw.name);
	const displayName = stringOf$1(raw.display_name);
	const version = stringOf$1(raw.version);
	const sourceRepo = stringOf$1(raw.source_repo);
	const sourceRef = stringOf$1(raw.source_ref);
	if (name === void 0 || !PACK_NAME$1.test(name)) return void 0;
	if (displayName === void 0 || version === void 0) return void 0;
	if (sourceRepo === void 0 || !SOURCE_REPO.test(sourceRepo)) return void 0;
	if (sourceRef === void 0 || sourceRef.includes("..")) return void 0;
	const author = typeof raw.author === "object" && raw.author !== null ? raw.author : {};
	return {
		name,
		displayName,
		version,
		description: stringOf$1(raw.description) ?? "",
		authorName: stringOf$1(author.name) ?? "",
		authorGithub: stringOf$1(author.github) ?? "",
		trustTier: trustTierOf(raw.trust_tier),
		categories: stringArrayOf(raw.categories),
		language: stringOf$1(raw.language) ?? "",
		license: stringOf$1(raw.license) ?? "",
		soundCount: numberOrUndefined(raw.sound_count) ?? 0,
		totalSizeBytes: numberOrUndefined(raw.total_size_bytes),
		sourceRepo,
		sourceRef,
		sourcePath: stringOf$1(raw.source_path) ?? ".",
		manifestSha256: stringOf$1(raw.manifest_sha256),
		tags: stringArrayOf(raw.tags),
		previewSounds: stringArrayOf(raw.preview_sounds),
		quality: stringOf$1(raw.quality),
		updated: stringOf$1(raw.updated)
	};
}
/**
* Parse a whole index document.
* @param value - parsed JSON from the registry (or a cache file).
* @param fetchedAt - timestamp to record for this index.
* @returns the validated index.
* @throws when the document is not the v1 index shape.
*/
function parseRegistryIndex(value, fetchedAt) {
	if (typeof value !== "object" || value === null) throw new Error("registry index is not an object");
	const raw = value;
	if (raw.version !== 1) throw new Error(`unsupported registry index version: ${JSON.stringify(raw.version)}`);
	if (!Array.isArray(raw.packs)) throw new Error("registry index has no packs array");
	const packs = raw.packs.map(parsePack).filter((pack) => pack !== void 0);
	if (packs.length === 0) throw new Error("registry index carries no usable pack entry");
	return {
		fetchedAt,
		packs
	};
}
/**
* Fetch and validate the registry index.
* @param fetchImpl - HTTP implementation; injectable for tests.
* @returns the validated index and its source document.
* @throws on network failure, a non-2xx response, or an invalid document.
*/
async function fetchRegistryIndex(fetchImpl = httpFetch) {
	const response = await fetchImpl(REGISTRY_URL, { accept: "application/json" });
	if (!response.ok) throw new Error(`registry request failed: HTTP ${String(response.status)}`);
	const body = JSON.parse(new TextDecoder().decode(response.bytes));
	return {
		index: parseRegistryIndex(body, (/* @__PURE__ */ new Date()).toISOString()),
		document: body
	};
}
/**
* Persist the fetched registry document next to the installed packs, atomically.
*
* The file keeps the registry's documented wire shape — `version` and the
* snake_case pack fields — because {@link readRegistryCache} validates it with
* the same parser that validates a fetched document. Writing the internal view
* instead made every read reject the file, which silently disabled the cache
* and re-downloaded the index on every call.
* @param document - the fetched wire document, plus the plugin's `fetchedAt` stamp.
* @param env - environment to read `DSH_HOME` from.
*/
async function writeRegistryCache(document, env = process.env) {
	const target = registryPath(env);
	await mkdir(dirname(target), { recursive: true });
	const temporary = `${target}.tmp`;
	await writeFile(temporary, `${JSON.stringify(document)}\n`, "utf8");
	await rename(temporary, target);
}
/**
* Read the cached index.
* @param env - environment to read `DSH_HOME` from.
* @returns the cached index, or undefined when absent or unreadable.
*/
async function readRegistryCache(env = process.env) {
	try {
		const text = await readFile(registryPath(env), "utf8");
		const raw = JSON.parse(text);
		return parseRegistryIndex(raw, stringOf$1(raw.fetchedAt) ?? (/* @__PURE__ */ new Date(0)).toISOString());
	} catch {
		return;
	}
}
/**
* Serve the registry, refreshing when the cache is missing or stale.
* A failed refresh keeps the cached copy rather than leaving the UI empty.
* @param options - `force` bypasses the TTL; `env` selects the home; `fetchImpl` is injectable.
* @returns the index and whether this call fetched it.
* @throws when the cache is stale or absent and the refresh also fails.
*/
async function loadRegistry(options = {}) {
	const env = options.env ?? process.env;
	const cached = await readRegistryCache(env);
	const fresh = cached !== void 0 && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS && Number.isFinite(Date.parse(cached.fetchedAt));
	if (!options.force && fresh) return {
		index: cached,
		fetched: false
	};
	try {
		const { index, document } = await fetchRegistryIndex(options.fetchImpl ?? httpFetch);
		await writeRegistryCache({
			...document,
			fetchedAt: index.fetchedAt
		}, env);
		return {
			index,
			fetched: true
		};
	} catch (error) {
		if (cached !== void 0) return {
			index: cached,
			fetched: false
		};
		throw error;
	}
}
/**
* The CDN URL of one file inside a pack's repository.
* jsDelivr is used because it serves tagged GitHub content without needing the
* repository tarball; `github.com` and `raw.githubusercontent.com` are not
* reachable from every deployment.
* @param pack - registry entry naming the repository, ref, and pack root.
* @param file - pack-relative file path from the CESP manifest.
* @returns the absolute URL to fetch.
*/
function packFileUrl(pack, file) {
	const encoded = `${pack.sourcePath === "." || pack.sourcePath === "" ? "" : `${pack.sourcePath.replace(/\/+$/, "")}/`}${file}`.split("/").map(encodeURIComponent).join("/");
	return `https://cdn.jsdelivr.net/gh/${pack.sourceRepo}@${encodeURIComponent(pack.sourceRef)}/${encoded}`;
}
//#endregion
//#region src/host/packs.ts
/**
* CESP pack storage: manifest validation, verified download, and the on-disk
* layout under the harness home.
*
* Every file is verified against the SHA-256 the pack's own manifest declares,
* and the manifest itself against the registry's digest, so a truncated or
* substituted download is rejected before it can be selected as a sound pack.
* @module dsh-openpeon/host/packs
*/
/** Refuse pathological packs before writing anything to disk. */
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 67108864;
/** Installed-pack directory names are registry pack ids. */
const PACK_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONTENT_TYPES = {
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/ogg",
	".m4a": "audio/mp4",
	".mp4": "audio/mp4",
	".flac": "audio/flac",
	".aac": "audio/aac"
};
function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
function stringOf(value) {
	return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
/** A pack-relative path: never absolute, never escaping, never a bare directory. */
function packRelativePath(value) {
	const path = stringOf(value);
	if (path === void 0) return void 0;
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) return void 0;
	if (path.split("/").some((segment) => segment === ".." || segment === "")) return void 0;
	return path;
}
/**
* Validate a CESP v1.0 manifest.
* @param value - parsed `openpeon.json`.
* @returns the manifest, narrowed to the categories this plugin drives.
* @throws when the document is not a usable CESP manifest.
*/
function parseCesplManifest(value) {
	if (typeof value !== "object" || value === null) throw new Error("pack manifest is not an object");
	const raw = value;
	const cespVersion = stringOf(raw.cesp_version);
	if (cespVersion === void 0) throw new Error("pack manifest declares no cesp_version");
	const name = stringOf(raw.name);
	if (name === void 0 || !PACK_NAME.test(name)) throw new Error("pack manifest declares no usable name");
	if (typeof raw.categories !== "object" || raw.categories === null) throw new Error("pack manifest declares no categories");
	const categories = {};
	for (const [category, entry] of Object.entries(raw.categories)) {
		if (!isCesplCategory(category)) continue;
		if (typeof entry !== "object" || entry === null) continue;
		const sounds = entry.sounds;
		if (!Array.isArray(sounds)) continue;
		const parsed = [];
		for (const sound of sounds) {
			if (typeof sound !== "object" || sound === null) continue;
			const record = sound;
			const file = packRelativePath(record.file);
			if (file === void 0) continue;
			parsed.push({
				file,
				label: stringOf(record.label) ?? file,
				sha256: stringOf(record.sha256)
			});
		}
		if (parsed.length > 0) categories[category] = parsed;
	}
	if (Object.keys(categories).length === 0) throw new Error("pack manifest offers no usable CESP category");
	return {
		cespVersion,
		name,
		displayName: stringOf(raw.display_name) ?? name,
		version: stringOf(raw.version) ?? "0.0.0",
		license: stringOf(raw.license) ?? "",
		language: stringOf(raw.language) ?? "",
		categories
	};
}
/** Content type for one pack file, by extension. */
function contentTypeOf(file) {
	const dot = file.lastIndexOf(".");
	return (dot === -1 ? "" : CONTENT_TYPES[file.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}
/**
* Download one URL into memory.
* @param url - absolute URL.
* @param fetchImpl - HTTP implementation; injectable for tests.
* @returns the response body bytes.
* @throws on network failure or a non-2xx response.
*/
async function download(url, fetchImpl) {
	const response = await fetchImpl(url);
	if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)} for ${url}`);
	return response.bytes;
}
/**
* Download, verify, and install one registry pack.
*
* The pack is assembled in a staging directory and moved into place only after
* every digest matches, so a failed or interrupted install never leaves a
* half-written pack selectable.
* @param pack - validated registry entry to install.
* @param options - `env` selects the harness home; `fetchImpl` is injectable for tests.
* @returns the installed pack record.
* @throws on manifest or digest mismatch, oversize packs, or filesystem failure.
*/
async function installPack(pack, options = {}) {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? httpFetch;
	const root = packsDir(env);
	await mkdir(root, { recursive: true });
	const manifestBytes = await download(packFileUrl(pack, "openpeon.json"), fetchImpl);
	const manifestSha256 = sha256(manifestBytes);
	if (pack.manifestSha256 !== void 0 && pack.manifestSha256.toLowerCase() !== manifestSha256) throw new Error(`pack manifest digest mismatch for ${pack.name}`);
	let manifest;
	try {
		manifest = parseCesplManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
	} catch (error) {
		throw new Error(`pack ${pack.name} has an unusable manifest: ${String(error)}`);
	}
	const unique = /* @__PURE__ */ new Map();
	for (const sounds of Object.values(manifest.categories)) for (const sound of sounds ?? []) if (!unique.has(sound.file)) unique.set(sound.file, sound);
	if (unique.size > MAX_FILES) throw new Error(`pack ${pack.name} declares ${String(unique.size)} files; the limit is ${String(MAX_FILES)}`);
	const staging = safeJoin(root, `.staging-${pack.name}-${randomUUID()}`);
	await mkdir(staging, { recursive: true });
	try {
		let totalSizeBytes = 0;
		for (const [file, sound] of unique) {
			const bytes = await download(packFileUrl(pack, file), fetchImpl);
			if (sound.sha256 !== void 0 && sound.sha256.toLowerCase() !== sha256(bytes)) throw new Error(`pack ${pack.name} file ${file} failed its digest check`);
			totalSizeBytes += bytes.byteLength;
			if (totalSizeBytes > MAX_TOTAL_BYTES) throw new Error(`pack ${pack.name} exceeds the ${String(MAX_TOTAL_BYTES)}-byte limit`);
			const target = safeJoin(staging, ...file.split("/"));
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, bytes);
		}
		await writeFile(join(staging, "openpeon.json"), manifestBytes);
		const categories = {};
		const preview = [];
		for (const [category, sounds] of Object.entries(manifest.categories)) {
			categories[category] = sounds.length;
			if (preview.length < 3) preview.push(sounds[0].file);
		}
		const installed = {
			name: pack.name,
			displayName: manifest.displayName,
			version: manifest.version,
			sourceVersion: pack.version,
			license: manifest.license,
			language: manifest.language,
			installedAt: (/* @__PURE__ */ new Date()).toISOString(),
			manifestSha256,
			soundCount: unique.size,
			totalSizeBytes,
			categories,
			preview
		};
		await writeFile(join(staging, "installed.json"), `${JSON.stringify(installed, void 0, 2)}\n`, "utf8");
		const target = safeJoin(root, pack.name);
		if (existsSync(target)) {
			const previous = safeJoin(root, `.previous-${pack.name}-${randomUUID()}`);
			await rename(target, previous);
			await rename(staging, target);
			await rm(previous, {
				recursive: true,
				force: true
			});
		} else await rename(staging, target);
		return installed;
	} catch (error) {
		await rm(staging, {
			recursive: true,
			force: true
		});
		throw error;
	}
}
/**
* The installed directory of one pack, refusing unknown names.
* @param name - pack id.
* @param env - environment to read `DSH_HOME` from.
* @returns the absolute pack directory.
* @throws when the name is not a registry pack id.
*/
function packDir(name, env = process.env) {
	if (!PACK_NAME.test(name)) throw new Error(`invalid pack name: ${JSON.stringify(name)}`);
	return safeJoin(packsDir(env), name);
}
/**
* Read every installed pack record.
* @param env - environment to read `DSH_HOME` from.
* @returns records sorted by display name; unreadable directories are skipped.
*/
async function readInstalledPacks(env = process.env) {
	let names;
	try {
		names = await readdir(packsDir(env));
	} catch {
		return [];
	}
	const packs = [];
	for (const name of names) {
		if (!PACK_NAME.test(name)) continue;
		try {
			const record = JSON.parse(await readFile(safeJoin(packsDir(env), name, "installed.json"), "utf8"));
			if (typeof record.name === "string" && PACK_NAME.test(record.name)) packs.push(record);
		} catch {}
	}
	return packs.sort((left, right) => left.displayName.localeCompare(right.displayName));
}
/**
* Read one installed pack's manifest.
* @param name - pack id.
* @param env - environment to read `DSH_HOME` from.
* @returns the validated manifest and the pack directory.
* @throws when the pack is not installed or its manifest is unusable.
*/
async function readPackManifest(name, env = process.env) {
	const dir = packDir(name, env);
	return {
		manifest: parseCesplManifest(JSON.parse(await readFile(join(dir, "openpeon.json"), "utf8"))),
		dir
	};
}
/**
* Remove one installed pack.
* @param name - pack id.
* @param env - environment to read `DSH_HOME` from.
* @returns true when a pack directory was removed.
*/
async function removePack(name, env = process.env) {
	const dir = packDir(name, env);
	if (!existsSync(dir)) return false;
	await rm(dir, {
		recursive: true,
		force: true
	});
	if ((await readState(env)).activePack === name) await writeState({ activePack: null }, env);
	return true;
}
/**
* Read the selection state.
* @param env - environment to read `DSH_HOME` from.
* @returns the state, defaulting to no selection.
*/
async function readState(env = process.env) {
	try {
		const active = JSON.parse(await readFile(statePath(env), "utf8")).activePack;
		return { activePack: typeof active === "string" && PACK_NAME.test(active) ? active : null };
	} catch {
		return { activePack: null };
	}
}
/**
* Record the selection, atomically.
* @param state - state to persist.
* @param env - environment to read `DSH_HOME` from.
*/
async function writeState(state, env = process.env) {
	const target = statePath(env);
	await mkdir(dirname(target), { recursive: true });
	const temporary = `${target}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, void 0, 2)}\n`, "utf8");
	await rename(temporary, target);
}
/**
* Pick one sound to play for a CESP category.
*
* A category may hold several sounds; the choice is uniform over them so a
* pack's variety is actually used, matching how OpenPeon plays a pack.
* @param cespCategory - CESP category name.
* @param env - environment to read `DSH_HOME` from.
* @returns the absolute file path and its content type, or undefined when nothing is selected.
*/
async function resolveSound(cespCategory, env = process.env) {
	const state = await readState(env);
	if (state.activePack === null) return void 0;
	let manifest;
	let dir;
	try {
		({manifest, dir} = await readPackManifest(state.activePack, env));
	} catch {
		return;
	}
	const sounds = manifest.categories[cespCategory];
	if (sounds === void 0 || sounds.length === 0) return void 0;
	const chosen = sounds[Math.floor(Math.random() * sounds.length)];
	return {
		path: safeJoin(dir, ...chosen.file.split("/")),
		contentType: contentTypeOf(chosen.file)
	};
}
/**
* Resolve one file of one installed pack, for previewing.
*
* Only files the pack's own manifest lists are reachable, so the route cannot
* be used to read arbitrary files.
* @param name - pack id.
* @param file - pack-relative path.
* @param env - environment to read `DSH_HOME` from.
* @returns the absolute path and content type, or undefined when not listed.
*/
async function resolvePackFile(name, file, env = process.env) {
	const relative = packRelativePath(file);
	if (relative === void 0) return void 0;
	let manifest;
	let dir;
	try {
		({manifest, dir} = await readPackManifest(name, env));
	} catch {
		return;
	}
	if (!Object.values(manifest.categories).some((sounds) => (sounds ?? []).some((sound) => sound.file === relative))) return void 0;
	return {
		path: safeJoin(dir, ...relative.split("/")),
		contentType: contentTypeOf(relative)
	};
}
//#endregion
//#region src/host/routes.ts
/**
* The plugin's HTTP surface.
*
* One prefix owns everything: the pack catalogue and selection endpoints the
* settings page drives, plus the two audio routes (one sound for a category,
* one explicit file for previews). Reads are public like the rest of the
* frontend's non-index assets; every mutating request must come from the
* page's own origin, so a third-party document cannot install or delete packs
* through a visitor's browser.
* @module dsh-openpeon/host/routes
*/
/** Route prefix owning the catalogue API and both audio routes. */
const ROUTE_PREFIX = "/openpeon";
/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 8192;
/** One JSON response. */
function sendJson(res, status, value) {
	const body = Buffer.from(JSON.stringify(value));
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.byteLength),
		"cache-control": "no-store"
	});
	res.end(body);
}
/** One plain-text failure, kept minimal so it leaks nothing. */
function sendError(res, status, message) {
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(`${message}\n`);
}
/** One audio response. */
async function sendAudio(res, resolved) {
	if (resolved === void 0) {
		sendError(res, 404, "no such sound");
		return;
	}
	let body;
	try {
		body = await readFile(resolved.path);
	} catch {
		sendError(res, 404, "no such sound");
		return;
	}
	res.writeHead(200, {
		"content-type": resolved.contentType,
		"content-length": String(body.byteLength),
		"cache-control": "no-store"
	});
	res.end(body);
}
/**
* Whether a mutating request came from the page's own origin.
*
* Browsers attach `Origin` to every non-GET request, including same-origin
* ones, so a mismatched or unparsable origin is refused. A request with no
* `Origin` at all is not from a browser page and is allowed through, which
* keeps local tooling usable.
* @param req - incoming request.
* @returns true when the request may mutate plugin state.
*/
function isSameOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	const host = req.headers.host;
	if (host === void 0) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
/**
* Read and parse a bounded JSON body.
* @param req - incoming request.
* @returns the parsed value, or undefined when the body is absent, oversized, or invalid JSON.
*/
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.byteLength;
		if (size > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	if (size === 0) return void 0;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return;
	}
}
/** The catalogue view: what is installed, what is selected, and the index freshness. */
async function stateResponse(env, fetchImpl) {
	const [packs, state] = await Promise.all([readInstalledPacks(env), readState(env)]);
	let indexFetchedAt = null;
	let available = 0;
	try {
		const { index } = await loadRegistry({
			env,
			...fetchImpl === void 0 ? {} : { fetchImpl }
		});
		indexFetchedAt = index.fetchedAt;
		available = index.packs.length;
	} catch {}
	return {
		activePack: state.activePack,
		packs,
		registry: {
			fetchedAt: indexFetchedAt,
			total: available
		}
	};
}
/**
* Build the request handler.
* @param options - `env` selects the harness home; `fetchImpl` is injectable for tests.
* @returns the handler for every request under {@link ROUTE_PREFIX}.
*/
function createRouteHandler(options = {}) {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl;
	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://dsh.invalid");
		const path = url.pathname.slice(9);
		const method = req.method ?? "GET";
		try {
			if (path === "/state" && method === "GET") {
				sendJson(res, 200, await stateResponse(env, fetchImpl));
				return;
			}
			if (path === "/registry" && method === "GET") {
				const { index } = await loadRegistry({
					force: url.searchParams.get("refresh") === "1",
					env,
					...fetchImpl === void 0 ? {} : { fetchImpl }
				});
				sendJson(res, 200, {
					fetchedAt: index.fetchedAt,
					packs: index.packs
				});
				return;
			}
			if (path.startsWith("/sound/") && method === "GET") {
				const category = decodeURIComponent(path.slice(7));
				if (!isCesplCategory(category)) {
					sendError(res, 404, "unknown category");
					return;
				}
				await sendAudio(res, await resolveSound(category, env));
				return;
			}
			if (path.startsWith("/preview/") && method === "GET") {
				const rest = path.slice(9);
				const separator = rest.indexOf("/");
				if (separator <= 0) {
					sendError(res, 404, "no such preview");
					return;
				}
				await sendAudio(res, await resolvePackFile(decodeURIComponent(rest.slice(0, separator)), decodeURIComponent(rest.slice(separator + 1)), env));
				return;
			}
			if (method === "POST") {
				if (!isSameOrigin(req)) {
					sendError(res, 403, "cross-origin request refused");
					return;
				}
				const body = await readJsonBody(req);
				if (typeof body !== "object" || body === null) {
					sendError(res, 400, "expected a JSON object body");
					return;
				}
				const fields = body;
				if (path === "/install") {
					const name = fields.name;
					if (typeof name !== "string") {
						sendError(res, 400, "expected { name }");
						return;
					}
					const { index } = await loadRegistry({
						env,
						...fetchImpl === void 0 ? {} : { fetchImpl }
					});
					const entry = index.packs.find((pack) => pack.name === name);
					if (entry === void 0) {
						sendError(res, 404, `no registry pack named ${name}`);
						return;
					}
					const installed = await installPack(entry, {
						env,
						...fetchImpl === void 0 ? {} : { fetchImpl }
					});
					if ((await readState(env)).activePack === null) await writeState({ activePack: installed.name }, env);
					sendJson(res, 200, { installed });
					return;
				}
				if (path === "/remove") {
					const name = fields.name;
					if (typeof name !== "string") {
						sendError(res, 400, "expected { name }");
						return;
					}
					sendJson(res, 200, { removed: await removePack(name, env) });
					return;
				}
				if (path === "/active") {
					const pack = fields.pack;
					if (pack !== null && typeof pack !== "string") {
						sendError(res, 400, "expected { pack: string | null }");
						return;
					}
					if (typeof pack === "string") {
						if (!(await readInstalledPacks(env)).some((candidate) => candidate.name === pack)) {
							sendError(res, 404, `pack ${pack} is not installed`);
							return;
						}
					}
					await writeState({ activePack: pack }, env);
					sendJson(res, 200, { activePack: pack });
					return;
				}
			}
			sendError(res, 404, "not found");
		} catch (error) {
			sendError(res, 500, error instanceof Error ? error.message : String(error));
		}
	};
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "dsh-openpeon";
/** Services required before the pack routes can be registered. */
const inject = ["webServer"];
/**
* Register the plugin's HTTP surface.
*
* The prefix is public, like every other non-index asset the frontend serves;
* mutating requests are additionally refused unless they originate from the
* page's own origin.
* @param ctx - plugin context carrying the webServer service.
*/
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: createRouteHandler()
	}), "ui-notifications: pack routes");
}
//#endregion
export { apply, inject, name };

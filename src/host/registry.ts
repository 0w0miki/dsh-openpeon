/**
 * The PeonPing pack registry: fetching, validating, and caching `index.json`.
 *
 * The registry is untrusted network input, so every field this plugin acts on
 * is validated before use; a malformed entry is dropped rather than allowed to
 * decide a filesystem path or a download URL.
 * @module dsh-openpeon/host/registry
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { httpFetch, type FetchBytes } from './http.ts'
import { registryPath } from './paths.ts'

/** Registry index at the pinned schema version this plugin reads. */
const REGISTRY_URL = 'https://cdn.jsdelivr.net/gh/PeonPing/registry@main/index.json'

/** How long a cached index is served before a refresh is attempted. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** Machine-readable pack id, exactly as the registry schema constrains it. */
const PACK_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** GitHub `owner/repo` as the registry schema constrains it. */
const SOURCE_REPO = /^[\w.-]+\/[\w.-]+$/

/** One pack entry, narrowed to the fields this plugin reads. */
export interface RegistryPack {
  /** Machine-readable pack id; also the installed directory name. */
  name: string
  /** Human-readable pack name. */
  displayName: string
  /** Semantic version of the pack. */
  version: string
  /** Short description. */
  description: string
  /** Author display name, when the registry carries one. */
  authorName: string
  /** Author GitHub handle, when the registry carries one. */
  authorGithub: string
  /** Registry trust tier. */
  trustTier: 'official' | 'verified' | 'community'
  /** CESP categories this pack provides. */
  categories: string[]
  /** Language id of the voice lines. */
  language: string
  /** SPDX license identifier, as declared. */
  license: string
  /** Number of sound entries across all categories. */
  soundCount: number
  /** Total size of the pack in bytes, when known. */
  totalSizeBytes: number | undefined
  /** GitHub `owner/repo` holding the pack. */
  sourceRepo: string
  /** Git ref the registry pinned. */
  sourceRef: string
  /** Path inside the repo to the pack root; `.` means the repo root. */
  sourcePath: string
  /** SHA-256 of the pack's `openpeon.json`, when the registry carries one. */
  manifestSha256: string | undefined
  /** Searchable tags. */
  tags: string[]
  /** Representative sound filenames for previewing. */
  previewSounds: string[]
  /** Automated audio-check tier, when the registry carries one. */
  quality: string | undefined
  /** Last registry update date, when known. */
  updated: string | undefined
}

/** A validated index plus the moment this process read it. */
export interface RegistryIndex {
  /** ISO timestamp of the fetch that produced this index. */
  fetchedAt: string
  /** Validated pack entries. */
  packs: RegistryPack[]
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function trustTierOf(value: unknown): RegistryPack['trustTier'] {
  return value === 'official' || value === 'verified' ? value : 'community'
}

/** A relative path a pack manifest may name: never absolute, never escaping. */
function packRelativePath(value: unknown): string | undefined {
  const path = stringOf(value)
  if (path === undefined) return undefined
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) return undefined
  const segments = path.split('/')
  if (segments.some(segment => segment === '..' || segment === '')) return undefined
  return path
}

/**
 * Narrow one registry entry to the fields this plugin reads.
 * @param value - one element of the index's `packs` array.
 * @returns the entry, or undefined when a field this plugin acts on is missing or malformed.
 */
export function parsePack(value: unknown): RegistryPack | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const name = stringOf(raw.name)
  const displayName = stringOf(raw.display_name)
  const version = stringOf(raw.version)
  const sourceRepo = stringOf(raw.source_repo)
  const sourceRef = stringOf(raw.source_ref)
  if (name === undefined || !PACK_NAME.test(name)) return undefined
  if (displayName === undefined || version === undefined) return undefined
  if (sourceRepo === undefined || !SOURCE_REPO.test(sourceRepo)) return undefined
  if (sourceRef === undefined || sourceRef.includes('..')) return undefined
  const author = typeof raw.author === 'object' && raw.author !== null ? raw.author as Record<string, unknown> : {}
  return {
    name,
    displayName,
    version,
    description: stringOf(raw.description) ?? '',
    authorName: stringOf(author.name) ?? '',
    authorGithub: stringOf(author.github) ?? '',
    trustTier: trustTierOf(raw.trust_tier),
    categories: stringArrayOf(raw.categories),
    language: stringOf(raw.language) ?? '',
    license: stringOf(raw.license) ?? '',
    soundCount: numberOrUndefined(raw.sound_count) ?? 0,
    totalSizeBytes: numberOrUndefined(raw.total_size_bytes),
    sourceRepo,
    sourceRef,
    sourcePath: stringOf(raw.source_path) ?? '.',
    manifestSha256: stringOf(raw.manifest_sha256),
    tags: stringArrayOf(raw.tags),
    previewSounds: stringArrayOf(raw.preview_sounds),
    quality: stringOf(raw.quality),
    updated: stringOf(raw.updated),
  }
}

/**
 * Parse a whole index document.
 * @param value - parsed JSON from the registry (or a cache file).
 * @param fetchedAt - timestamp to record for this index.
 * @returns the validated index.
 * @throws when the document is not the v1 index shape.
 */
export function parseRegistryIndex(value: unknown, fetchedAt: string): RegistryIndex {
  if (typeof value !== 'object' || value === null) throw new Error('registry index is not an object')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) throw new Error(`unsupported registry index version: ${JSON.stringify(raw.version)}`)
  if (!Array.isArray(raw.packs)) throw new Error('registry index has no packs array')
  const packs = raw.packs.map(parsePack).filter((pack): pack is RegistryPack => pack !== undefined)
  if (packs.length === 0) throw new Error('registry index carries no usable pack entry')
  return { fetchedAt, packs }
}

/** A fetched index: the validated view, plus the document it was read from. */
export interface FetchedRegistry {
  /** Validated packs and the moment they were fetched. */
  index: RegistryIndex
  /**
   * The wire document exactly as received. The cache stores this rather than
   * the internal view, so one parser validates both a fetched document and a
   * cached one — the two shapes cannot drift apart.
   */
  document: Record<string, unknown>
}

/**
 * Fetch and validate the registry index.
 * @param fetchImpl - HTTP implementation; injectable for tests.
 * @returns the validated index and its source document.
 * @throws on network failure, a non-2xx response, or an invalid document.
 */
export async function fetchRegistryIndex(fetchImpl: FetchBytes = httpFetch): Promise<FetchedRegistry> {
  const response = await fetchImpl(REGISTRY_URL, { accept: 'application/json' })
  if (!response.ok) throw new Error(`registry request failed: HTTP ${String(response.status)}`)
  const body = JSON.parse(new TextDecoder().decode(response.bytes)) as unknown
  const index = parseRegistryIndex(body, new Date().toISOString())
  return { index, document: body as Record<string, unknown> }
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
export async function writeRegistryCache(
  document: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = registryPath(env)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify(document)}\n`, 'utf8')
  await rename(temporary, target)
}

/**
 * Read the cached index.
 * @param env - environment to read `DSH_HOME` from.
 * @returns the cached index, or undefined when absent or unreadable.
 */
export async function readRegistryCache(env: NodeJS.ProcessEnv = process.env): Promise<RegistryIndex | undefined> {
  try {
    const text = await readFile(registryPath(env), 'utf8')
    const raw = JSON.parse(text) as Record<string, unknown>
    const fetchedAt = stringOf(raw.fetchedAt) ?? new Date(0).toISOString()
    return parseRegistryIndex(raw, fetchedAt)
  } catch {
    return undefined
  }
}

/**
 * Serve the registry, refreshing when the cache is missing or stale.
 * A failed refresh keeps the cached copy rather than leaving the UI empty.
 * @param options - `force` bypasses the TTL; `env` selects the home; `fetchImpl` is injectable.
 * @returns the index and whether this call fetched it.
 * @throws when the cache is stale or absent and the refresh also fails.
 */
export async function loadRegistry(options: {
  force?: boolean
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchBytes
} = {}): Promise<{ index: RegistryIndex; fetched: boolean }> {
  const env = options.env ?? process.env
  const cached = await readRegistryCache(env)
  const fresh = cached !== undefined
    && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS
    && Number.isFinite(Date.parse(cached.fetchedAt))
  if (!options.force && fresh) return { index: cached, fetched: false }
  try {
    const { index, document } = await fetchRegistryIndex(options.fetchImpl ?? httpFetch)
    await writeRegistryCache({ ...document, fetchedAt: index.fetchedAt }, env)
    return { index, fetched: true }
  } catch (error) {
    if (cached !== undefined) return { index: cached, fetched: false }
    throw error
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
export function packFileUrl(pack: RegistryPack, file: string): string {
  const root = pack.sourcePath === '.' || pack.sourcePath === '' ? '' : `${pack.sourcePath.replace(/\/+$/, '')}/`
  const encoded = `${root}${file}`.split('/').map(encodeURIComponent).join('/')
  return `https://cdn.jsdelivr.net/gh/${pack.sourceRepo}@${encodeURIComponent(pack.sourceRef)}/${encoded}`
}

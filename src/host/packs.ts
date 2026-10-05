/**
 * CESP pack storage: manifest validation, verified download, and the on-disk
 * layout under the harness home.
 *
 * Every file is verified against the SHA-256 the pack's own manifest declares,
 * and the manifest itself against the registry's digest, so a truncated or
 * substituted download is rejected before it can be selected as a sound pack.
 * @module dsh-openpeon/host/packs
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isCesplCategory, type CesplCategory } from '../cesp.ts'
import { httpFetch, type FetchBytes } from './http.ts'
import { packFileUrl, type RegistryPack } from './registry.ts'
import { packsDir, safeJoin, statePath } from './paths.ts'

/** Refuse pathological packs before writing anything to disk. */
const MAX_FILES = 500
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

/** Installed-pack directory names are registry pack ids. */
const PACK_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
}

/** One sound entry inside a CESP category. */
export interface CesplSound {
  /** Pack-relative file path. */
  file: string
  /** Human label supplied by the pack author. */
  label: string
  /** Declared SHA-256, when the pack carries one. */
  sha256: string | undefined
}

/** A validated CESP v1.0 pack manifest. */
export interface CesplManifest {
  cespVersion: string
  name: string
  displayName: string
  version: string
  license: string
  language: string
  categories: Partial<Record<CesplCategory, CesplSound[]>>
}

/** Bookkeeping written beside a pack's own manifest when it is installed. */
export interface InstalledPack {
  name: string
  displayName: string
  /**
   * Version declared by the pack's own manifest. Display/diagnostic only: it is
   * the author's field and, for roughly one pack in seven, lags the registry.
   */
  version: string
  /**
   * Registry version this pack was installed from. Updates compare against
   * this, not the manifest field, so a pack whose two version strings disagree
   * is not reported as perpetually updatable.
   */
  sourceVersion: string
  license: string
  language: string
  /** ISO timestamp of the install that produced these files. */
  installedAt: string
  /** SHA-256 of `openpeon.json` as verified at install time. */
  manifestSha256: string
  /** Number of sound entries across all categories. */
  soundCount: number
  /** Bytes of sound files written. */
  totalSizeBytes: number
  /** Sound count per CESP category. */
  categories: Partial<Record<CesplCategory, number>>
  /** Up to three manifest-relative paths usable as previews. */
  preview: string[]
}

/** The plugin's selection state. */
export interface PluginState {
  /** Registry pack id of the selected pack, or null when none is selected. */
  activePack: string | null
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** A pack-relative path: never absolute, never escaping, never a bare directory. */
function packRelativePath(value: unknown): string | undefined {
  const path = stringOf(value)
  if (path === undefined) return undefined
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) return undefined
  const segments = path.split('/')
  if (segments.some(segment => segment === '..' || segment === '')) return undefined
  return path
}

/**
 * Validate a CESP v1.0 manifest.
 * @param value - parsed `openpeon.json`.
 * @returns the manifest, narrowed to the categories this plugin drives.
 * @throws when the document is not a usable CESP manifest.
 */
export function parseCesplManifest(value: unknown): CesplManifest {
  if (typeof value !== 'object' || value === null) throw new Error('pack manifest is not an object')
  const raw = value as Record<string, unknown>
  const cespVersion = stringOf(raw.cesp_version)
  if (cespVersion === undefined) throw new Error('pack manifest declares no cesp_version')
  const name = stringOf(raw.name)
  if (name === undefined || !PACK_NAME.test(name)) throw new Error('pack manifest declares no usable name')
  if (typeof raw.categories !== 'object' || raw.categories === null) {
    throw new Error('pack manifest declares no categories')
  }
  const categories: Partial<Record<CesplCategory, CesplSound[]>> = {}
  for (const [category, entry] of Object.entries(raw.categories as Record<string, unknown>)) {
    if (!isCesplCategory(category)) continue
    if (typeof entry !== 'object' || entry === null) continue
    const sounds = (entry as Record<string, unknown>).sounds
    if (!Array.isArray(sounds)) continue
    const parsed: CesplSound[] = []
    for (const sound of sounds) {
      if (typeof sound !== 'object' || sound === null) continue
      const record = sound as Record<string, unknown>
      const file = packRelativePath(record.file)
      if (file === undefined) continue
      parsed.push({
        file,
        label: stringOf(record.label) ?? file,
        sha256: stringOf(record.sha256),
      })
    }
    if (parsed.length > 0) categories[category] = parsed
  }
  if (Object.keys(categories).length === 0) throw new Error('pack manifest offers no usable CESP category')
  return {
    cespVersion,
    name,
    displayName: stringOf(raw.display_name) ?? name,
    version: stringOf(raw.version) ?? '0.0.0',
    license: stringOf(raw.license) ?? '',
    language: stringOf(raw.language) ?? '',
    categories,
  }
}

/** Content type for one pack file, by extension. */
function contentTypeOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return (dot === -1 ? '' : CONTENT_TYPES[file.slice(dot).toLowerCase()]) ?? 'application/octet-stream'
}

/**
 * Download one URL into memory.
 * @param url - absolute URL.
 * @param fetchImpl - HTTP implementation; injectable for tests.
 * @returns the response body bytes.
 * @throws on network failure or a non-2xx response.
 */
async function download(url: string, fetchImpl: FetchBytes): Promise<Uint8Array> {
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)} for ${url}`)
  return response.bytes
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
export async function installPack(
  pack: RegistryPack,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchBytes } = {},
): Promise<InstalledPack> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? httpFetch
  const root = packsDir(env)
  await mkdir(root, { recursive: true })

  const manifestBytes = await download(packFileUrl(pack, 'openpeon.json'), fetchImpl)
  const manifestSha256 = sha256(manifestBytes)
  if (pack.manifestSha256 !== undefined && pack.manifestSha256.toLowerCase() !== manifestSha256) {
    throw new Error(`pack manifest digest mismatch for ${pack.name}`)
  }
  let manifest: CesplManifest
  try {
    manifest = parseCesplManifest(JSON.parse(new TextDecoder().decode(manifestBytes)))
  } catch (error) {
    throw new Error(`pack ${pack.name} has an unusable manifest: ${String(error)}`)
  }

  const unique = new Map<string, CesplSound>()
  for (const sounds of Object.values(manifest.categories)) {
    for (const sound of sounds ?? []) if (!unique.has(sound.file)) unique.set(sound.file, sound)
  }
  if (unique.size > MAX_FILES) throw new Error(`pack ${pack.name} declares ${String(unique.size)} files; the limit is ${String(MAX_FILES)}`)

  const staging = safeJoin(root, `.staging-${pack.name}-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    let totalSizeBytes = 0
    for (const [file, sound] of unique) {
      const bytes = await download(packFileUrl(pack, file), fetchImpl)
      if (sound.sha256 !== undefined && sound.sha256.toLowerCase() !== sha256(bytes)) {
        throw new Error(`pack ${pack.name} file ${file} failed its digest check`)
      }
      totalSizeBytes += bytes.byteLength
      if (totalSizeBytes > MAX_TOTAL_BYTES) throw new Error(`pack ${pack.name} exceeds the ${String(MAX_TOTAL_BYTES)}-byte limit`)
      const target = safeJoin(staging, ...file.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    await writeFile(join(staging, 'openpeon.json'), manifestBytes)

    const categories: Partial<Record<CesplCategory, number>> = {}
    const preview: string[] = []
    for (const [category, sounds] of Object.entries(manifest.categories) as [CesplCategory, CesplSound[]][]) {
      categories[category] = sounds.length
      if (preview.length < 3) preview.push(sounds[0]!.file)
    }
    const installed: InstalledPack = {
      name: pack.name,
      displayName: manifest.displayName,
      version: manifest.version,
      sourceVersion: pack.version,
      license: manifest.license,
      language: manifest.language,
      installedAt: new Date().toISOString(),
      manifestSha256,
      soundCount: unique.size,
      totalSizeBytes,
      categories,
      preview,
    }
    await writeFile(join(staging, 'installed.json'), `${JSON.stringify(installed, undefined, 2)}\n`, 'utf8')

    const target = safeJoin(root, pack.name)
    if (existsSync(target)) {
      const previous = safeJoin(root, `.previous-${pack.name}-${randomUUID()}`)
      await rename(target, previous)
      await rename(staging, target)
      await rm(previous, { recursive: true, force: true })
    } else {
      await rename(staging, target)
    }
    return installed
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/**
 * The installed directory of one pack, refusing unknown names.
 * @param name - pack id.
 * @param env - environment to read `DSH_HOME` from.
 * @returns the absolute pack directory.
 * @throws when the name is not a registry pack id.
 */
export function packDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!PACK_NAME.test(name)) throw new Error(`invalid pack name: ${JSON.stringify(name)}`)
  return safeJoin(packsDir(env), name)
}

/**
 * Read every installed pack record.
 * @param env - environment to read `DSH_HOME` from.
 * @returns records sorted by display name; unreadable directories are skipped.
 */
export async function readInstalledPacks(env: NodeJS.ProcessEnv = process.env): Promise<InstalledPack[]> {
  let names: string[]
  try {
    names = await readdir(packsDir(env))
  } catch {
    return []
  }
  const packs: InstalledPack[] = []
  for (const name of names) {
    if (!PACK_NAME.test(name)) continue
    try {
      const record = JSON.parse(await readFile(safeJoin(packsDir(env), name, 'installed.json'), 'utf8')) as InstalledPack
      if (typeof record.name === 'string' && PACK_NAME.test(record.name)) packs.push(record)
    } catch {
      // A directory without a readable record is not an installed pack.
    }
  }
  return packs.sort((left, right) => left.displayName.localeCompare(right.displayName))
}

/**
 * Read one installed pack's manifest.
 * @param name - pack id.
 * @param env - environment to read `DSH_HOME` from.
 * @returns the validated manifest and the pack directory.
 * @throws when the pack is not installed or its manifest is unusable.
 */
export async function readPackManifest(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ manifest: CesplManifest; dir: string }> {
  const dir = packDir(name, env)
  return { manifest: parseCesplManifest(JSON.parse(await readFile(join(dir, 'openpeon.json'), 'utf8'))), dir }
}

/**
 * Remove one installed pack.
 * @param name - pack id.
 * @param env - environment to read `DSH_HOME` from.
 * @returns true when a pack directory was removed.
 */
export async function removePack(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const dir = packDir(name, env)
  if (!existsSync(dir)) return false
  await rm(dir, { recursive: true, force: true })
  const state = await readState(env)
  if (state.activePack === name) await writeState({ activePack: null }, env)
  return true
}

/**
 * Read the selection state.
 * @param env - environment to read `DSH_HOME` from.
 * @returns the state, defaulting to no selection.
 */
export async function readState(env: NodeJS.ProcessEnv = process.env): Promise<PluginState> {
  try {
    const raw = JSON.parse(await readFile(statePath(env), 'utf8')) as Record<string, unknown>
    const active = raw.activePack
    return { activePack: typeof active === 'string' && PACK_NAME.test(active) ? active : null }
  } catch {
    return { activePack: null }
  }
}

/**
 * Record the selection, atomically.
 * @param state - state to persist.
 * @param env - environment to read `DSH_HOME` from.
 */
export async function writeState(state: PluginState, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = statePath(env)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, 'utf8')
  await rename(temporary, target)
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
export async function resolveSound(
  cespCategory: CesplCategory,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; contentType: string } | undefined> {
  const state = await readState(env)
  if (state.activePack === null) return undefined
  let manifest: CesplManifest
  let dir: string
  try {
    ({ manifest, dir } = await readPackManifest(state.activePack, env))
  } catch {
    return undefined
  }
  const sounds = manifest.categories[cespCategory]
  if (sounds === undefined || sounds.length === 0) return undefined
  const chosen = sounds[Math.floor(Math.random() * sounds.length)]!
  return { path: safeJoin(dir, ...chosen.file.split('/')), contentType: contentTypeOf(chosen.file) }
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
export async function resolvePackFile(
  name: string,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; contentType: string } | undefined> {
  const relative = packRelativePath(file)
  if (relative === undefined) return undefined
  let manifest: CesplManifest
  let dir: string
  try {
    ({ manifest, dir } = await readPackManifest(name, env))
  } catch {
    return undefined
  }
  const listed = Object.values(manifest.categories)
    .some(sounds => (sounds ?? []).some(sound => sound.file === relative))
  if (!listed) return undefined
  return { path: safeJoin(dir, ...relative.split('/')), contentType: contentTypeOf(relative) }
}

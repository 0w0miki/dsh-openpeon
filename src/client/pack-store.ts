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

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SoundPlayer } from './sound-player.ts'

/** Registry route base, matching the Host's prefix. */
const BASE = '/openpeon'

/** One installed pack, as the Host reports it. */
export interface InstalledPackView {
  name: string
  displayName: string
  /** Version declared by the pack's own manifest. */
  version: string
  /** Registry version this pack was installed from; the fallback comparison. */
  sourceVersion: string
  /** SHA-256 of the installed `openpeon.json`, as verified at install time. */
  manifestSha256: string
  license: string
  language: string
  installedAt: string
  soundCount: number
  totalSizeBytes: number
  categories: Record<string, number>
  preview: string[]
}

/** One registry pack, as the Host reports it. */
export interface RegistryPackView {
  name: string
  displayName: string
  version: string
  description: string
  authorName: string
  authorGithub: string
  trustTier: 'official' | 'verified' | 'community'
  categories: string[]
  language: string
  license: string
  soundCount: number
  totalSizeBytes?: number
  tags: string[]
  quality?: string
  updated?: string
  sourceRepo: string
  /** SHA-256 of the pack's manifest at the pinned ref; the update comparison. */
  manifestSha256?: string
}

/** Catalogue state the settings page renders. */
export interface PackState {
  /**
   * Progress of the local facts (installed packs and the selection). These are
   * a file read on the Host, so they settle almost immediately and never wait
   * on the registry.
   */
  installedStatus: 'loading' | 'ready' | 'error'
  /** Progress of the registry catalogue, which needs the network. */
  registryStatus: 'loading' | 'ready' | 'error'
  /** Selected pack id, or null when nothing is selected. */
  activePack: string | null
  /** Installed packs, by display name. */
  packs: InstalledPackView[]
  /** Registry entries; empty until the index is fetched. */
  registry: RegistryPackView[]
  /** When the served registry index was fetched, or null when unavailable. */
  registryFetchedAt: string | null
  /** Pack id with an operation in flight, or null. */
  busy: string | null
  /** Last user-facing failure, cleared by the next action. */
  error: string | null
}

/** Catalogue actions the settings page calls. */
export interface PackActions {
  /** Load installed packs, selection, and the registry. */
  load(): Promise<void>
  /** Force a registry refresh, then reload. */
  refresh(): Promise<void>
  /** Download and install one registry pack. */
  install(name: string): Promise<void>
  /** Delete one installed pack. */
  remove(name: string): Promise<void>
  /** Select a pack, or clear the selection with null. */
  select(name: string | null): Promise<void>
  /** Play one installed file as a preview. */
  preview(pack: string, file: string): void
}

/** The store plus its actions, as the inject face hands them out. */
export interface PackController extends PackActions {
  /** Catalogue snapshot store, bound to the `usePacks` hook. */
  hooks: SnapshotStore<PackState>
}

/** Map one installed pack from the Host payload. */
function installedOf(value: unknown): InstalledPackView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string' || typeof raw.displayName !== 'string') return undefined
  return {
    name: raw.name,
    displayName: raw.displayName,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    // Records written before this field existed fall back to the manifest
    // version, which may over-report an update once and self-corrects after it.
    sourceVersion: typeof raw.sourceVersion === 'string'
      ? raw.sourceVersion
      : typeof raw.version === 'string' ? raw.version : '0.0.0',
    manifestSha256: typeof raw.manifestSha256 === 'string' ? raw.manifestSha256 : '',
    license: typeof raw.license === 'string' ? raw.license : '',
    language: typeof raw.language === 'string' ? raw.language : '',
    installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : '',
    soundCount: typeof raw.soundCount === 'number' ? raw.soundCount : 0,
    totalSizeBytes: typeof raw.totalSizeBytes === 'number' ? raw.totalSizeBytes : 0,
    categories: typeof raw.categories === 'object' && raw.categories !== null
      ? raw.categories as Record<string, number>
      : {},
    preview: Array.isArray(raw.preview) ? raw.preview.filter((item): item is string => typeof item === 'string') : [],
  }
}

/** Map one registry entry from the Host payload. */
function registryPackOf(value: unknown): RegistryPackView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string' || typeof raw.displayName !== 'string') return undefined
  const trustTier = raw.trustTier === 'official' || raw.trustTier === 'verified' ? raw.trustTier : 'community'
  const size = raw.totalSizeBytes
  return {
    name: raw.name,
    displayName: raw.displayName,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    description: typeof raw.description === 'string' ? raw.description : '',
    authorName: typeof raw.authorName === 'string' ? raw.authorName : '',
    authorGithub: typeof raw.authorGithub === 'string' ? raw.authorGithub : '',
    trustTier,
    categories: Array.isArray(raw.categories)
      ? raw.categories.filter((item): item is string => typeof item === 'string')
      : [],
    language: typeof raw.language === 'string' ? raw.language : '',
    license: typeof raw.license === 'string' ? raw.license : '',
    soundCount: typeof raw.soundCount === 'number' ? raw.soundCount : 0,
    ...typeof size === 'number' ? { totalSizeBytes: size } : {},
    tags: Array.isArray(raw.tags) ? raw.tags.filter((item): item is string => typeof item === 'string') : [],
    ...typeof raw.quality === 'string' ? { quality: raw.quality } : {},
    ...typeof raw.updated === 'string' ? { updated: raw.updated } : {},
    sourceRepo: typeof raw.sourceRepo === 'string' ? raw.sourceRepo : '',
    ...typeof raw.manifestSha256 === 'string' ? { manifestSha256: raw.manifestSha256 } : {},
  }
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
export function hasUpdate(installed: InstalledPackView, latest: RegistryPackView): boolean {
  if (latest.manifestSha256 !== undefined && installed.manifestSha256 !== '') {
    return latest.manifestSha256 !== installed.manifestSha256
  }
  return latest.version !== installed.sourceVersion
}

/**
 * Build the catalogue store and its actions.
 * @param player - the shared sound player, used for previews.
 * @param fetchImpl - fetch implementation; injectable for tests.
 * @returns the store bound to `usePacks` plus its actions.
 */
export function createPackStore(
  player: SoundPlayer,
  fetchImpl: typeof fetch = fetch,
): PackController {
  const hooks = createSnapshotStore<PackState>({
    installedStatus: 'loading',
    registryStatus: 'loading',
    activePack: null,
    packs: [],
    registry: [],
    registryFetchedAt: null,
    busy: null,
    error: null,
  }, { flush: 'raf' })

  /** Send one mutating request, surfacing the Host's message on failure. */
  const post = async (path: string, body: unknown): Promise<void> => {
    const response = await fetchImpl(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${String(response.status)}`)
  }

  /**
   * Read the local facts. Settles on its own status, so the installed list
   * renders without waiting for the catalogue.
   */
  const loadState = async (): Promise<void> => {
    try {
      const response = await fetchImpl(`${BASE}/state`)
      if (!response.ok) throw new Error(`state request failed: HTTP ${String(response.status)}`)
      const payload = await response.json() as Record<string, unknown>
      const packs = Array.isArray(payload.packs)
        ? payload.packs.map(installedOf).filter((pack): pack is InstalledPackView => pack !== undefined)
        : []
      const registry = payload.registry as Record<string, unknown> | undefined
      hooks.set({
        ...hooks.getSnapshot(),
        installedStatus: 'ready',
        activePack: typeof payload.activePack === 'string' ? payload.activePack : null,
        packs,
        // A Host that reports freshness fills this in; otherwise the catalogue
        // request below is what knows.
        ...typeof registry?.fetchedAt === 'string' ? { registryFetchedAt: registry.fetchedAt } : {},
      })
    } catch (error) {
      hooks.set({
        ...hooks.getSnapshot(),
        installedStatus: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Read the online catalogue. Independently of {@link loadState}. */
  const loadRegistry = async (refresh: boolean): Promise<void> => {
    hooks.set({ ...hooks.getSnapshot(), registryStatus: 'loading' })
    try {
      const response = await fetchImpl(`${BASE}/registry${refresh ? '?refresh=1' : ''}`)
      if (!response.ok) throw new Error(`registry request failed: HTTP ${String(response.status)}`)
      const payload = await response.json() as Record<string, unknown>
      const registry = Array.isArray(payload.packs)
        ? payload.packs.map(registryPackOf).filter((pack): pack is RegistryPackView => pack !== undefined)
        : []
      hooks.set({
        ...hooks.getSnapshot(),
        registryStatus: 'ready',
        registry,
        registryFetchedAt: typeof payload.fetchedAt === 'string' ? payload.fetchedAt : null,
      })
    } catch (error) {
      hooks.set({
        ...hooks.getSnapshot(),
        registryStatus: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Collapse a failure into the store's error slot instead of throwing at the UI. */
  const guard = async (busy: string | null, action: () => Promise<void>): Promise<void> => {
    hooks.set({ ...hooks.getSnapshot(), busy, error: null })
    try {
      await action()
    } catch (error) {
      hooks.set({ ...hooks.getSnapshot(), busy: null, error: error instanceof Error ? error.message : String(error) })
      return
    }
    hooks.set({ ...hooks.getSnapshot(), busy: null })
  }

  return {
    hooks,

    async load() {
      // Both start together and settle independently: the installed list is a
      // local file read and must never wait behind the index download.
      hooks.set({ ...hooks.getSnapshot(), error: null })
      await Promise.all([loadState(), loadRegistry(false)])
    },

    async refresh() {
      await guard(null, async () => {
        await Promise.all([loadRegistry(true), loadState()])
      })
    },

    async install(name) {
      await guard(name, async () => {
        await post('/install', { name })
        // Only the local facts changed; the catalogue is untouched.
        await loadState()
      })
    },

    async remove(name) {
      await guard(name, async () => {
        await post('/remove', { name })
        await loadState()
      })
    },

    async select(name) {
      await guard(null, async () => {
        await post('/active', { pack: name })
        await loadState()
      })
    },

    preview(pack, file) {
      player.playUrl(`${BASE}/preview/${encodeURIComponent(pack)}/${file.split('/').map(encodeURIComponent).join('/')}`, 0.8)
    },
  }
}

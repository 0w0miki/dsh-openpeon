// @vitest-environment jsdom
/**
 * The catalogue store: every action round-trips through the Host and then
 * re-reads the authoritative state, a failure lands in the store's error slot
 * instead of throwing at the UI, and previews address the Host's preview route.
 */

import { expect, it, vi } from 'vitest'
import { createPackStore, hasUpdate } from '../src/client/pack-store.ts'
import type { InstalledPackView, RegistryPackView } from '../src/client/pack-store.ts'
import type { SoundPlayer } from '../src/client/sound-player.ts'

/** Installed-pack payload the Host's `/state` route returns. */
const STATE = {
  activePack: 'abbot',
  packs: [{
    name: 'abbot',
    displayName: 'The Abbot',
    version: '1.2.0',
    sourceVersion: '1.2.1',
    license: 'fair-use',
    language: 'en',
    installedAt: '2026-01-01T00:00:00.000Z',
    manifestSha256: 'a'.repeat(64),
    soundCount: 14,
    totalSizeBytes: 440163,
    categories: { 'task.complete': 3 },
    preview: ['sounds/ab_vict_01.mp3'],
  }],
  registry: { fetchedAt: '2026-01-01T00:00:00.000Z', total: 2 },
}

/** Registry payload the Host's `/registry` route returns. */
const REGISTRY = {
  fetchedAt: '2026-01-01T00:00:00.000Z',
  packs: [
    {
      name: 'abbot',
      displayName: 'The Abbot',
      version: '1.3.0',
      description: 'Monastery lord',
      authorName: 'Marko',
      authorGithub: 'koyev',
      trustTier: 'official',
      categories: ['task.complete'],
      language: 'en',
      license: 'fair-use',
      soundCount: 14,
      totalSizeBytes: 440163,
      tags: ['gaming'],
      previewSounds: [],
      quality: 'gold',
      updated: '2026-03-03',
      sourceRepo: 'openpeon-stronghold/abbot',
      manifestSha256: 'e'.repeat(64),
    },
    {
      name: 'peon',
      displayName: 'Peon',
      version: '1.0.0',
      description: 'Work complete',
      authorName: 'PeonPing',
      authorGithub: 'PeonPing',
      trustTier: 'community',
      categories: ['task.complete'],
      language: 'en',
      license: 'CC0-1.0',
      soundCount: 6,
      tags: ['classic'],
      previewSounds: [],
      sourceRepo: 'PeonPing/peon',
      manifestSha256: 'f'.repeat(64),
    },
  ],
}

/** Record every request and answer from a small route table. */
function stubRoutes(options: { failPost?: boolean } = {}): { calls: { method: string; url: string; body?: unknown }[] } {
  const calls: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, ...init?.body === undefined ? {} : { body: JSON.parse(init.body) } })
    if (method === 'POST' && options.failPost === true) {
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('install exploded') })
    }
    if (url.endsWith('/state')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(STATE) })
    if (url.includes('/registry')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(REGISTRY) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  })
  return { calls }
}

/** A player that records preview URLs instead of scheduling audio. */
function fakePlayer(): { player: SoundPlayer; played: string[] } {
  const played: string[] = []
  const player = { playUrl: (url: string) => { played.push(url) } } as unknown as SoundPlayer
  return { player, played }
}

it('loads installed packs, the selection, and the registry', async () => {
  stubRoutes()
  const { player } = fakePlayer()
  const store = createPackStore(player)
  await store.load()
  const state = store.hooks.getSnapshot()
  expect(state.installedStatus).toBe('ready')
  expect(state.registryStatus).toBe('ready')
  expect(state.activePack).toBe('abbot')
  expect(state.packs.map(pack => pack.name)).toEqual(['abbot'])
  // The registry version that produced the install is what updates compare.
  expect(state.packs[0]?.sourceVersion).toBe('1.2.1')
  expect(state.registry.map(pack => pack.name)).toEqual(['abbot', 'peon'])
  expect(state.registryFetchedAt).toBe('2026-01-01T00:00:00.000Z')
  expect(state.error).toBeNull()
})

it('installs through the Host and re-reads the state', async () => {
  const { calls } = stubRoutes()
  const { player } = fakePlayer()
  const store = createPackStore(player)
  await store.load()
  await store.install('peon')
  expect(calls.filter(call => call.method === 'POST')).toEqual([
    { method: 'POST', url: '/openpeon/install', body: { name: 'peon' } },
  ])
  // The Host owns the result, so the store refreshed from it.
  expect(calls.filter(call => call.url.endsWith('/state'))).toHaveLength(2)
  expect(store.hooks.getSnapshot().busy).toBeNull()
})

it('selects and clears the selection through the Host', async () => {
  const { calls } = stubRoutes()
  const { player } = fakePlayer()
  const store = createPackStore(player)
  await store.select('peon')
  await store.select(null)
  expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
    { pack: 'peon' },
    { pack: null },
  ])
})

it('surfaces a failed mutation in the error slot instead of throwing', async () => {
  stubRoutes({ failPost: true })
  const { player } = fakePlayer()
  const store = createPackStore(player)
  await expect(store.install('peon')).resolves.toBeUndefined()
  const state = store.hooks.getSnapshot()
  expect(state.error).toBe('install exploded')
  expect(state.busy).toBeNull()
})

it('addresses the Host preview route for an installed file', () => {
  stubRoutes()
  const { player, played } = fakePlayer()
  const store = createPackStore(player)
  store.preview('abbot', 'sounds/ab vict 01.mp3')
  expect(played).toEqual(['/openpeon/preview/abbot/sounds/ab%20vict%2001.mp3'])
})

it('forces a registry refresh when asked', async () => {
  const { calls } = stubRoutes()
  const { player } = fakePlayer()
  const store = createPackStore(player)
  await store.refresh()
  expect(calls.some(call => call.url === '/openpeon/registry?refresh=1')).toBe(true)
})

it('decides updates by manifest digest, falling back to version only without one', () => {
  const installed: InstalledPackView = {
    name: 'ae_qianyu',
    displayName: '陈千语',
    // Real shape: the pack's own manifest lags the registry by four releases.
    version: '1.0.0',
    sourceVersion: '1.0.4',
    manifestSha256: 'a'.repeat(64),
    license: 'CC0-1.0',
    language: 'zh',
    installedAt: '',
    soundCount: 6,
    totalSizeBytes: 1,
    categories: {},
    preview: [],
  }
  const entry = (over: Partial<RegistryPackView>): RegistryPackView => ({
    name: 'ae_qianyu',
    displayName: '陈千语',
    version: '1.0.4',
    description: '',
    authorName: '',
    authorGithub: '',
    trustTier: 'community',
    categories: [],
    language: 'zh',
    license: 'CC0-1.0',
    soundCount: 6,
    tags: [],
    sourceRepo: 'LiRiu/qianyu-chen-pack',
    ...over,
  })

  // Same content: nothing to update, whatever the version strings say.
  expect(hasUpdate(installed, entry({ manifestSha256: 'a'.repeat(64) }))).toBe(false)
  // Different content: an update is available.
  expect(hasUpdate(installed, entry({ manifestSha256: 'b'.repeat(64) }))).toBe(true)
  // No registry digest: fall back to the version recorded at install.
  expect(hasUpdate(installed, entry({}))).toBe(false)
  expect(hasUpdate({ ...installed, sourceVersion: '1.0.0' }, entry({}))).toBe(true)
  // A legacy record with no digest of its own also falls back.
  expect(hasUpdate({ ...installed, manifestSha256: '' }, entry({ manifestSha256: 'b'.repeat(64) }))).toBe(false)
})

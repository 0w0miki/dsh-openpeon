/**
 * Unit coverage for the untrusted-input boundaries: the registry index, the
 * CESP manifest, the pack-relative file paths, and the CDN URL builder. These
 * are the checks that decide whether a network document may name a filesystem
 * path or a download URL, so each rejection is asserted directly.
 */

import { expect, it } from 'vitest'
import { parseCesplManifest } from '../src/host/packs.ts'
import { loadRegistry, packFileUrl, parsePack, parseRegistryIndex, readRegistryCache, writeRegistryCache } from '../src/host/registry.ts'
import { safeJoin } from '../src/host/paths.ts'

/** A minimal valid CESP manifest, with the given categories. */
function manifestWith(categories: unknown): unknown {
  return {
    cesp_version: '1.0',
    name: 'testpack',
    display_name: 'Test Pack',
    version: '1.0.0',
    license: 'MIT',
    language: 'en',
    categories,
  }
}

it('accepts a valid CESP manifest and drops categories this plugin cannot drive', () => {
  const manifest = parseCesplManifest(manifestWith({
    'task.complete': { sounds: [{ file: 'sounds/a.mp3', label: 'A', sha256: 'a'.repeat(64) }] },
    'user.spam': { sounds: [{ file: 'sounds/b.mp3' }] },
  }))
  expect(Object.keys(manifest.categories)).toEqual(['task.complete'])
  expect(manifest.categories['task.complete']?.[0]?.label).toBe('A')
  expect(manifest.license).toBe('MIT')
})

it('rejects a manifest with no cesp_version, no name, or no usable category', () => {
  expect(() => parseCesplManifest({ name: 'x', categories: {} })).toThrow(/cesp_version/)
  expect(() => parseCesplManifest({ cesp_version: '1.0', categories: {} })).toThrow(/name/)
  expect(() => parseCesplManifest(manifestWith({ 'not.a.category': { sounds: [{ file: 'a.mp3' }] } })))
    .toThrow(/no usable CESP category/)
  expect(() => parseCesplManifest(manifestWith({ 'task.error': { sounds: [] } })))
    .toThrow(/no usable CESP category/)
})

it('drops sound entries whose file path is absolute or escapes the pack', () => {
  const manifest = parseCesplManifest(manifestWith({
    'task.error': {
      sounds: [
        { file: '../../etc/passwd' },
        { file: '/etc/passwd' },
        { file: 'https://evil.example/x.mp3' },
        { file: 'sounds/ok.mp3' },
      ],
    },
  }))
  expect(manifest.categories['task.error']?.map(sound => sound.file)).toEqual(['sounds/ok.mp3'])
})

/** A minimally valid registry entry, overridden per test. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'abbot',
    display_name: 'The Abbot',
    version: '1.2.1',
    trust_tier: 'community',
    categories: ['task.complete'],
    language: 'en',
    sound_count: 14,
    source_repo: 'openpeon-stronghold/abbot',
    source_ref: 'v1.2.1',
    ...overrides,
  }
}

it('narrows a registry entry and defaults the trust tier', () => {
  expect(parsePack(entry())).toMatchObject({
    name: 'abbot',
    trustTier: 'community',
    sourcePath: '.',
    manifestSha256: undefined,
  })
  expect(parsePack(entry({ trust_tier: 'official' }))?.trustTier).toBe('official')
  expect(parsePack(entry({ trust_tier: 'nonsense' }))?.trustTier).toBe('community')
})

it('rejects entries that could name a bad path or an arbitrary repository', () => {
  expect(parsePack(entry({ name: '../escape' }))).toBeUndefined()
  expect(parsePack(entry({ name: 'Upper' }))).toBeUndefined()
  expect(parsePack(entry({ source_repo: 'not-a-repo' }))).toBeUndefined()
  expect(parsePack(entry({ source_repo: '../../etc' }))).toBeUndefined()
  expect(parsePack(entry({ source_ref: 'refs/../..' }))).toBeUndefined()
  expect(parsePack({ ...entry(), display_name: undefined })).toBeUndefined()
})

it('parses an index, dropping malformed packs and rejecting a wrong version', () => {
  const index = parseRegistryIndex({ version: 1, packs: [entry(), { name: 'bad' }] }, 'now')
  expect(index.packs).toHaveLength(1)
  expect(index.fetchedAt).toBe('now')
  expect(() => parseRegistryIndex({ version: 2, packs: [entry()] }, 'now')).toThrow(/unsupported/)
  expect(() => parseRegistryIndex({ version: 1, packs: [] }, 'now')).toThrow(/no usable pack/)
})

it('builds CDN URLs from the entry, honoring a monorepo source path', () => {
  const pack = parsePack(entry())!
  expect(packFileUrl(pack, 'openpeon.json'))
    .toBe('https://cdn.jsdelivr.net/gh/openpeon-stronghold/abbot@v1.2.1/openpeon.json')
  const nested = parsePack(entry({ source_path: 'packs/abbot' }))!
  expect(packFileUrl(nested, 'sounds/a b.mp3'))
    .toBe('https://cdn.jsdelivr.net/gh/openpeon-stronghold/abbot@v1.2.1/packs/abbot/sounds/a%20b.mp3')
})

it('refuses a join that escapes its root', () => {
  expect(safeJoin('/tmp/root', 'packs', 'abbot')).toBe('/tmp/root/packs/abbot')
  expect(() => safeJoin('/tmp/root', '..', 'etc')).toThrow(/escapes/)
  expect(() => safeJoin('/tmp/root', 'packs', '..', '..', 'etc')).toThrow(/escapes/)
})

it('round-trips the registry cache and serves it without any network', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'dsh-openpeon-cache-'))
  const env = { DSH_HOME: home }
  try {
    const document = { version: 1, packs: [entry()] }
    const index = parseRegistryIndex(document, new Date().toISOString())
    // The cache is the fetched document plus the plugin's freshness stamp.
    await writeRegistryCache({ ...document, fetchedAt: index.fetchedAt }, env)

    const read = await readRegistryCache(env)
    expect(read?.packs.map(pack => pack.name)).toEqual(['abbot'])
    expect(read?.fetchedAt).toBe(index.fetchedAt)

    // Regression: the written document must satisfy the reader's own validation,
    // otherwise the cache is silently unusable and every call re-downloads.
    const noNetwork = (() => { throw new Error('the network must not be used') }) as never
    const served = await loadRegistry({ env, fetchImpl: noNetwork })
    expect(served.fetched).toBe(false)
    expect(served.index.packs.map(pack => pack.name)).toEqual(['abbot'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

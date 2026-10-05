/**
 * Live contract check against the real PeonPing registry and the real CDN.
 *
 * Skipped unless `OPENPEON_LIVE=1`, so the ordinary suite stays hermetic: this
 * one depends on the network, on jsDelivr, and on the registry's current
 * contents. Run it with:
 *
 *   OPENPEON_LIVE=1 pnpm vitest run tests/registry.live.spec.ts
 *
 * It answers the question the stubbed specs cannot: does the registry document
 * we actually receive still match the fields this plugin reads, and do real
 * packs still install with every digest verified?
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installPack, readInstalledPacks, resolveSound, writeState } from '../src/host/packs.ts'
import { loadRegistry } from '../src/host/registry.ts'

const live = process.env.OPENPEON_LIVE === '1'

/** A pack known to be in the registry and small enough to install in a test. */
const PACK = 'abbot'

describe.skipIf(!live)('live registry contract', () => {
  let home: string
  let env: NodeJS.ProcessEnv

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-openpeon-live-'))
    env = { DSH_HOME: home }
  })

  afterAll(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('fetches an index whose entries still carry every field the plugin reads', async () => {
    const { index, fetched } = await loadRegistry({ force: true, env })
    expect(fetched).toBe(true)
    expect(index.packs.length).toBeGreaterThan(300)

    const abbot = index.packs.find(pack => pack.name === PACK)
    expect(abbot).toBeDefined()
    // The fields that decide a download URL and a filesystem path.
    expect(abbot?.sourceRepo).toMatch(/^[\w.-]+\/[\w.-]+$/)
    expect(abbot?.sourceRef).not.toBe('')
    expect(abbot?.categories).toContain('task.complete')
    expect(abbot?.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(abbot?.soundCount).toBeGreaterThan(0)
  }, 60_000)

  it('installs a real pack with every digest verified, then resolves a sound', async () => {
    const { index } = await loadRegistry({ env })
    const abbot = index.packs.find(pack => pack.name === PACK)
    expect(abbot).toBeDefined()

    const installed = await installPack(abbot!, { env })
    expect(installed.name).toBe(PACK)
    // The registry version that produced the install is what updates compare;
    // the manifest's own version is recorded separately because the two
    // disagree for a meaningful share of real packs.
    expect(installed.sourceVersion).toBe(abbot!.version)
    // Only the files the six CESP categories this plugin drives reference are
    // fetched, so the installed count is at most the registry's pack-wide one
    // (which also counts categories and `extras/` we never play).
    expect(installed.soundCount).toBeGreaterThan(0)
    expect(installed.soundCount).toBeLessThanOrEqual(abbot!.soundCount)
    expect(installed.totalSizeBytes).toBeGreaterThan(0)
    expect(Object.keys(installed.categories).length).toBeGreaterThan(0)

    // The manifest landed beside the sounds, and the record survived a re-read.
    const manifest = JSON.parse(await readFile(
      join(home, 'dsh-openpeon', 'packs', PACK, 'openpeon.json'), 'utf8',
    )) as Record<string, unknown>
    expect(manifest.cesp_version).toBeDefined()
    expect((await readInstalledPacks(env)).map(pack => pack.name)).toEqual([PACK])

    // Selecting it makes the category route resolvable to a real file.
    await writeState({ activePack: PACK }, env)
    const resolved = await resolveSound('task.complete', env)
    expect(resolved).toBeDefined()
    expect(resolved!.contentType.startsWith('audio/')).toBe(true)
    const bytes = await readFile(resolved!.path)
    expect(bytes.byteLength).toBeGreaterThan(1000)
  }, 120_000)

  it('records the digest that decides updates for a pack whose manifest version lags', async () => {
    // The reported case, verified against the real registry: a pack whose own
    // `openpeon.json` declares a version the registry has moved past (at the
    // time of writing registry 1.0.4, manifest 1.0.0). Comparing version
    // strings made it look permanently updatable; the manifest digest we
    // verified is the registry's, so there is nothing to update.
    const { index } = await loadRegistry({ env })
    const target = index.packs.find(pack => pack.name === 'ae_qianyu')
    expect(target).toBeDefined()
    expect(target!.manifestSha256).toMatch(/^[a-f0-9]{64}$/)

    const installed = await installPack(target!, { env })
    expect(installed.sourceVersion).toBe(target!.version)
    expect(installed.manifestSha256).toBe(target!.manifestSha256)
  }, 120_000)
})

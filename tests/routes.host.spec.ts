/**
 * REAL-composition coverage for the pack routes: a test-only cordis.yml booted
 * through the vendored Loader mounts the webserver plus this package's Host
 * face, and every assertion observes the HTTP response a browser receives.
 *
 * The registry and the pack files are served through the injected HTTP layer,
 * so the install path — index lookup, manifest validation, per-file digest
 * check, atomic placement — runs exactly as it does against the CDN, without
 * the network. `DSH_HOME` points at a scratch directory so nothing touches the
 * developer's real pack store.
 */

import { request, type IncomingHttpHeaders } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as PackRoutes from '../src/index.ts'
import type { HttpResponse } from '../src/host/http.ts'

/** The HTTP implementation the routes will use; each test installs one. */
const network = vi.hoisted(() => ({
  impl: undefined as ((url: string, options?: { accept?: string }) => Promise<unknown>) | undefined,
}))

vi.mock('../src/host/http.ts', () => ({
  httpFetch: (url: string, options?: { accept?: string }) => {
    if (network.impl === undefined) throw new Error('no network stub installed')
    return network.impl(url, options)
  },
}))

/** The `openpeon.json` and sound a fake pack serves. */
const SOUND_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)])

let root: string | undefined
let home: string | undefined
let context: Context | undefined
let previousHome: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  network.impl = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  previousHome = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  root = undefined
  home = undefined
})

/** One HTTP response, decoded to the pieces the assertions read. */
interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** Issue one request, optionally with a JSON body and an Origin header. */
function send(base: string, method: string, path: string, body?: unknown, origin?: string): Promise<HttpResult> {
  const url = new URL(base)
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      method,
      path,
      headers: {
        ...payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.byteLength) },
        ...origin === undefined ? {} : { origin },
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** Serve one fake registry plus one fake pack through the injected HTTP layer. */
function stubNetwork(options: { manifestSha256?: string; soundSha256?: string } = {}): void {
  const manifestObject = {
    cesp_version: '1.0',
    name: 'testpack',
    display_name: 'Test Pack',
    version: '1.0.0',
    license: 'MIT',
    language: 'en',
    categories: {
      'task.complete': {
        sounds: [{
          file: 'sounds/hit.wav',
          label: 'Hit',
          sha256: options.soundSha256 ?? createHash('sha256').update(SOUND_BYTES).digest('hex'),
        }],
      },
    },
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifestObject))
  const index = {
    version: 1,
    total_packs: 1,
    packs: [{
      name: 'testpack',
      display_name: 'Test Pack',
      version: '1.0.0',
      description: 'A pack used by the specs',
      author: { name: 'Spec', github: 'spec' },
      trust_tier: 'official',
      categories: ['task.complete'],
      language: 'en',
      license: 'MIT',
      sound_count: 1,
      total_size_bytes: SOUND_BYTES.byteLength,
      source_repo: 'spec/testpack',
      source_ref: 'v1.0.0',
      source_path: '.',
      ...options.manifestSha256 === undefined
        ? {}
        : { manifest_sha256: options.manifestSha256 },
      tags: ['spec'],
      preview_sounds: ['sounds/hit.wav'],
      quality: 'gold',
      updated: '2026-01-01',
    }],
  }
  network.impl = (url: string): Promise<HttpResponse> => {
    if (url.includes('PeonPing/registry')) return Promise.resolve(jsonResponse(index))
    if (url.endsWith('/openpeon.json')) return Promise.resolve(bytesResponse(manifestBytes))
    if (url.endsWith('/sounds/hit.wav')) return Promise.resolve(bytesResponse(SOUND_BYTES))
    return Promise.resolve({ status: 404, ok: false, bytes: new Uint8Array() })
  }
}

function jsonResponse(value: unknown): HttpResponse {
  return { status: 200, ok: true, bytes: new TextEncoder().encode(JSON.stringify(value)) }
}

function bytesResponse(bytes: Buffer): HttpResponse {
  return { status: 200, ok: true, bytes: new Uint8Array(bytes) }
}

/** Boot webserver plus the pack routes through the real Loader, returning the origin. */
async function boot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-openpeon-root-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-openpeon-home-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-client-ui-notifications'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-ui-notifications', PackRoutes],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return `http://127.0.0.1:${String(context.webServer.port)}`
}

it('declares the pack routes and the service they wait on', () => {
  expect(PackRoutes.name).toBe('dsh-openpeon')
  expect(PackRoutes.inject).toEqual(['webServer'])
})

it('starts with nothing installed and the registry catalogue available', async () => {
  stubNetwork()
  const base = await boot()
  const response = await send(base, 'GET', '/openpeon/state')
  expect(response.status).toBe(200)
  const state = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>
  expect(state.activePack).toBeNull()
  expect(state.packs).toEqual([])
  expect((state.registry as Record<string, unknown>).total).toBe(1)
})

it('installs a verified pack, selects it, and serves its sound for a category', async () => {
  stubNetwork()
  const base = await boot()
  const installed = await send(base, 'POST', '/openpeon/install', { name: 'testpack' }, base)
  expect(installed.status).toBe(200)
  const record = (JSON.parse(installed.body.toString('utf8')) as Record<string, unknown>).installed as Record<string, unknown>
  expect(record.name).toBe('testpack')
  expect(record.soundCount).toBe(1)
  // The registry version is recorded for update comparison; the manifest's own
  // version is kept separately.
  expect(record.sourceVersion).toBe('1.0.0')
  expect(record.version).toBe('1.0.0')

  // The first install becomes the selection, so the category route answers.
  const sound = await send(base, 'GET', '/openpeon/sound/task.complete')
  expect(sound.status).toBe(200)
  expect(sound.headers['content-type']).toBe('audio/wav')
  expect(sound.body.subarray(0, 4).toString('ascii')).toBe('RIFF')
  expect(sound.body.equals(SOUND_BYTES)).toBe(true)

  const state = JSON.parse((await send(base, 'GET', '/openpeon/state')).body.toString('utf8')) as Record<string, unknown>
  expect(state.activePack).toBe('testpack')
  expect((state.packs as unknown[])).toHaveLength(1)

  // The sound bytes landed under the scratch home, not beside the plugin.
  const onDisk = await readFile(join(home!, 'dsh-openpeon', 'packs', 'testpack', 'sounds', 'hit.wav'))
  expect(onDisk.equals(SOUND_BYTES)).toBe(true)
})

it('refuses a pack whose own manifest digest does not match the registry', async () => {
  stubNetwork({ manifestSha256: 'f'.repeat(64) })
  const base = await boot()
  const response = await send(base, 'POST', '/openpeon/install', { name: 'testpack' }, base)
  expect(response.status).toBe(500)
  expect(response.body.toString('utf8')).toContain('digest mismatch')
  // Nothing was written, so nothing can be selected.
  const state = JSON.parse((await send(base, 'GET', '/openpeon/state')).body.toString('utf8')) as Record<string, unknown>
  expect(state.packs).toEqual([])
})

it('refuses a pack file whose digest does not match its manifest', async () => {
  stubNetwork({ soundSha256: 'a'.repeat(64) })
  const base = await boot()
  const response = await send(base, 'POST', '/openpeon/install', { name: 'testpack' }, base)
  expect(response.status).toBe(500)
  expect(response.body.toString('utf8')).toContain('failed its digest check')
})

it('refuses a mutating request from another origin', async () => {
  stubNetwork()
  const base = await boot()
  const response = await send(base, 'POST', '/openpeon/install', { name: 'testpack' }, 'http://evil.example')
  expect(response.status).toBe(403)
  const state = JSON.parse((await send(base, 'GET', '/openpeon/state')).body.toString('utf8')) as Record<string, unknown>
  expect(state.packs).toEqual([])
})

it('answers unknown categories and escaped preview paths with 404', async () => {
  stubNetwork()
  const base = await boot()
  expect((await send(base, 'GET', '/openpeon/sound/task.progress')).status).toBe(404)
  expect((await send(base, 'GET', '/openpeon/sound/nonsense')).status).toBe(404)
  // `%2e%2e%2f` survives client-side normalization and must still be refused.
  expect((await send(base, 'GET', '/openpeon/preview/none/%2e%2e%2fpackage.json')).status).toBe(404)
})

it('removes a pack and clears the selection with it', async () => {
  stubNetwork()
  const base = await boot()
  await send(base, 'POST', '/openpeon/install', { name: 'testpack' }, base)
  expect((await send(base, 'GET', '/openpeon/sound/task.complete')).status).toBe(200)

  const removed = await send(base, 'POST', '/openpeon/remove', { name: 'testpack' }, base)
  expect(removed.status).toBe(200)
  const state = JSON.parse((await send(base, 'GET', '/openpeon/state')).body.toString('utf8')) as Record<string, unknown>
  expect(state.packs).toEqual([])
  expect(state.activePack).toBeNull()
  expect((await send(base, 'GET', '/openpeon/sound/task.complete')).status).toBe(404)
})

it('refuses to select a pack that is not installed', async () => {
  stubNetwork()
  const base = await boot()
  expect((await send(base, 'POST', '/openpeon/active', { pack: 'ghost' }, base)).status).toBe(404)
  expect((await send(base, 'POST', '/openpeon/active', { pack: null }, base)).status).toBe(200)
})

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

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isCesplCategory } from '../cesp.ts'
import {
  installPack, readInstalledPacks, readState, removePack,
  resolvePackFile, resolveSound, writeState,
} from './packs.ts'
import type { FetchBytes } from './http.ts'
import { loadRegistry } from './registry.ts'
import type { RegistryPack } from './registry.ts'

/** Route prefix owning the catalogue API and both audio routes. */
export const ROUTE_PREFIX = '/openpeon'

/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 8 * 1024

/** One JSON response. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** One plain-text failure, kept minimal so it leaks nothing. */
function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`${message}\n`)
}

/** One audio response. */
async function sendAudio(
  res: ServerResponse,
  resolved: { path: string; contentType: string } | undefined,
): Promise<void> {
  if (resolved === undefined) {
    sendError(res, 404, 'no such sound')
    return
  }
  let body: Buffer
  try {
    body = await readFile(resolved.path)
  } catch {
    sendError(res, 404, 'no such sound')
    return
  }
  res.writeHead(200, {
    'content-type': resolved.contentType,
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
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
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Read and parse a bounded JSON body.
 * @param req - incoming request.
 * @returns the parsed value, or undefined when the body is absent, oversized, or invalid JSON.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** The catalogue view: what is installed, what is selected, and the index freshness. */
async function stateResponse(env: NodeJS.ProcessEnv, fetchImpl: FetchBytes | undefined): Promise<unknown> {
  const [packs, state] = await Promise.all([readInstalledPacks(env), readState(env)])
  let indexFetchedAt: string | null = null
  let available = 0
  try {
    const { index } = await loadRegistry({ env, ...fetchImpl === undefined ? {} : { fetchImpl } })
    indexFetchedAt = index.fetchedAt
    available = index.packs.length
  } catch {
    // A first run with no network still shows the installed packs.
  }
  return {
    activePack: state.activePack,
    packs,
    registry: { fetchedAt: indexFetchedAt, total: available },
  }
}

/**
 * Build the request handler.
 * @param options - `env` selects the harness home; `fetchImpl` is injectable for tests.
 * @returns the handler for every request under {@link ROUTE_PREFIX}.
 */
export function createRouteHandler(options: {
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchBytes
} = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const path = url.pathname.slice(ROUTE_PREFIX.length)
    const method = req.method ?? 'GET'

    try {
      if (path === '/state' && method === 'GET') {
        sendJson(res, 200, await stateResponse(env, fetchImpl))
        return
      }

      if (path === '/registry' && method === 'GET') {
        const { index } = await loadRegistry({
          force: url.searchParams.get('refresh') === '1',
          env,
          ...fetchImpl === undefined ? {} : { fetchImpl },
        })
        sendJson(res, 200, { fetchedAt: index.fetchedAt, packs: index.packs })
        return
      }

      if (path.startsWith('/sound/') && method === 'GET') {
        const category = decodeURIComponent(path.slice('/sound/'.length))
        if (!isCesplCategory(category)) {
          sendError(res, 404, 'unknown category')
          return
        }
        await sendAudio(res, await resolveSound(category, env))
        return
      }

      if (path.startsWith('/preview/') && method === 'GET') {
        const rest = path.slice('/preview/'.length)
        const separator = rest.indexOf('/')
        if (separator <= 0) {
          sendError(res, 404, 'no such preview')
          return
        }
        const name = decodeURIComponent(rest.slice(0, separator))
        const file = decodeURIComponent(rest.slice(separator + 1))
        await sendAudio(res, await resolvePackFile(name, file, env))
        return
      }

      if (method === 'POST') {
        if (!isSameOrigin(req)) {
          sendError(res, 403, 'cross-origin request refused')
          return
        }
        const body = await readJsonBody(req)
        if (typeof body !== 'object' || body === null) {
          sendError(res, 400, 'expected a JSON object body')
          return
        }
        const fields = body as Record<string, unknown>

        if (path === '/install') {
          const name = fields.name
          if (typeof name !== 'string') {
            sendError(res, 400, 'expected { name }')
            return
          }
          const { index } = await loadRegistry({ env, ...fetchImpl === undefined ? {} : { fetchImpl } })
          const entry: RegistryPack | undefined = index.packs.find(pack => pack.name === name)
          if (entry === undefined) {
            sendError(res, 404, `no registry pack named ${name}`)
            return
          }
          const installed = await installPack(entry, { env, ...fetchImpl === undefined ? {} : { fetchImpl } })
          const state = await readState(env)
          if (state.activePack === null) await writeState({ activePack: installed.name }, env)
          sendJson(res, 200, { installed })
          return
        }

        if (path === '/remove') {
          const name = fields.name
          if (typeof name !== 'string') {
            sendError(res, 400, 'expected { name }')
            return
          }
          sendJson(res, 200, { removed: await removePack(name, env) })
          return
        }

        if (path === '/active') {
          const pack = fields.pack
          if (pack !== null && typeof pack !== 'string') {
            sendError(res, 400, 'expected { pack: string | null }')
            return
          }
          if (typeof pack === 'string') {
            const installed = await readInstalledPacks(env)
            if (!installed.some(candidate => candidate.name === pack)) {
              sendError(res, 404, `pack ${pack} is not installed`)
              return
            }
          }
          await writeState({ activePack: pack }, env)
          sendJson(res, 200, { activePack: pack })
          return
        }
      }

      sendError(res, 404, 'not found')
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
  }
}

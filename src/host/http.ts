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

import { get as httpGet } from 'node:http'
import { get as httpsGet, type RequestOptions } from 'node:https'

/** One response, reduced to what these callers read. */
export interface HttpResponse {
  /** HTTP status code. */
  status: number
  /** Whether the status is in the 2xx range. */
  ok: boolean
  /** Response body bytes. */
  bytes: Uint8Array
}

/** One request, as the registry and pack readers consume it. */
export type FetchBytes = (url: string, options?: { accept?: string }) => Promise<HttpResponse>

/** Redirects followed before giving up. */
const MAX_REDIRECTS = 5

/** Per-request inactivity timeout. */
const REQUEST_TIMEOUT_MS = 30_000

/** Hard cap on one response body. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/**
 * Perform one GET, following redirects.
 * @param url - absolute http(s) URL.
 * @param options - `accept`, when the caller wants a specific media type.
 * @returns the final response.
 * @throws on a transport error, a timeout, an oversized body, or too many redirects.
 */
export function httpFetch(url: string, options: { accept?: string } = {}): Promise<HttpResponse> {
  return request(url, options, MAX_REDIRECTS)
}

function request(url: string, options: { accept?: string }, redirectsLeft: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`invalid URL: ${url}`))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`unsupported protocol: ${parsed.protocol}`))
      return
    }
    const get = parsed.protocol === 'https:' ? httpsGet : httpGet
    const requestOptions: RequestOptions = {
      headers: {
        accept: options.accept ?? '*/*',
        'user-agent': 'dsh-openpeon',
      },
    }
    const req = get(parsed, requestOptions, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location !== undefined && redirectsLeft > 0) {
        res.resume()
        request(new URL(location, parsed).href, options, redirectsLeft - 1).then(resolve, reject)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error(`response exceeds ${String(MAX_RESPONSE_BYTES)} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        resolve({ status, ok: status >= 200 && status < 300, bytes: new Uint8Array(Buffer.concat(chunks)) })
      })
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(new Error(`request timed out after ${String(REQUEST_TIMEOUT_MS)}ms`)) })
    req.on('error', reject)
  })
}

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ProviderError } from '../../src/providers/types'

export interface RecordedRequest {
  method: string
  /** Path plus query string, as received. */
  url: string
  pathname: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: unknown
}

export interface FakeResponse {
  status?: number
  headers?: Record<string, string>
  /** JSON-encoded unless `raw` is given. */
  body?: unknown
  raw?: string
}

export type Handler = (req: RecordedRequest, base: string) => FakeResponse | 'hang'

export interface FakeApi {
  baseUrl: string
  origin: string
  requests: RecordedRequest[]
  route(key: string, handler: Handler): void
  close(): Promise<void>
}

/**
 * A local HTTP server standing in for a provider API. `isAuthorized` checks the auth headers;
 * routes are keyed `"METHOD /pathname"` (no query string). Unknown routes answer 404.
 */
export async function startFakeApi(opts: {
  prefix?: string
  isAuthorized: (headers: IncomingHttpHeaders) => boolean
  routes?: Record<string, Handler>
}): Promise<FakeApi> {
  const routes = new Map<string, Handler>(Object.entries(opts.routes ?? {}))
  const requests: RecordedRequest[] = []
  const hanging = new Set<import('node:http').ServerResponse>()
  let origin = ''

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const u = new URL(req.url ?? '/', origin)
      let body: unknown = undefined
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      const rec: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        pathname: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body,
      }
      requests.push(rec)
      const send = (r: FakeResponse): void => {
        const payload = r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body))
        res.writeHead(r.status ?? 200, {
          'content-type': r.raw !== undefined ? 'text/html' : 'application/json',
          ...r.headers,
        })
        res.end(payload)
      }
      if (!opts.isAuthorized(req.headers)) {
        send({ status: 401, body: { message: 'Bad credentials' } })
        return
      }
      const handler = routes.get(`${rec.method} ${rec.pathname}`)
      if (!handler) {
        send({ status: 404, body: { message: 'Not Found' } })
        return
      }
      const out = handler(rec, origin + (opts.prefix ?? ''))
      if (out === 'hang') {
        hanging.add(res)
        return
      }
      send(out)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  origin = `http://127.0.0.1:${port}`
  return {
    origin,
    baseUrl: origin + (opts.prefix ?? ''),
    requests,
    route: (key, handler) => routes.set(key, handler),
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of hanging) r.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** A loopback URL on which nothing is listening (connection refused). */
export async function refusedBaseUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

export function basic(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`
}

/** Await a promise that must reject with a ProviderError. */
export async function catchErr(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ProviderError) return e
    throw e
  }
  throw new Error('expected a ProviderError')
}

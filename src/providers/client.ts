import { ProviderError, type ProviderErrorCode } from './types'

export type AuthScheme = 'bearer' | 'basic' | 'private-token'

export interface ProviderFetchOptions {
  /** API base, e.g. `https://api.github.com` or `https://gitlab.example.com/api/v4`. */
  baseUrl: string
  /**
   * Path relative to baseUrl (`/user`, query string allowed). An absolute URL is accepted only
   * when it has the same origin as baseUrl (pagination `next` links), so the token is never sent
   * to a different host.
   */
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  token: string
  /** `basic` expects the token already in `user:secret` form. */
  authScheme: AuthScheme
  /** JSON-serialised as the request body. */
  body?: unknown
  signal?: AbortSignal
  /** Default 20000 ms. */
  timeoutMs?: number
  headers?: Record<string, string>
  /** Provider name used in error messages ("GitHub"). */
  label?: string
}

export interface ProviderResponse<T = unknown> {
  status: number
  headers: Headers
  /** Parsed JSON body, or null for an empty body. */
  data: T
  /** Final request URL. */
  url: string
}

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 3
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Validate an API base URL: https only (plain http allowed for loopback), no embedded credentials. */
export function assertAllowedBaseUrl(baseUrl: string): URL {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    throw new ProviderError('INVALID_ARGUMENT', 'Invalid API base URL.')
  }
  if (u.username || u.password) {
    throw new ProviderError('INVALID_ARGUMENT', 'The API base URL must not contain credentials.')
  }
  if (u.protocol === 'https:') return u
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return u
  throw new ProviderError('INVALID_ARGUMENT', `Only https API URLs are allowed (got ${u.protocol}//${u.host}).`)
}

function secretsFor(token: string): string[] {
  const secrets = new Set<string>()
  if (token) {
    secrets.add(token)
    secrets.add(Buffer.from(token, 'utf8').toString('base64'))
    secrets.add(encodeURIComponent(token))
    for (const part of token.split(':')) if (part.length >= 4) secrets.add(part)
  }
  // Longest first so a token is not partially replaced by one of its parts.
  return [...secrets].sort((a, b) => b.length - a.length)
}

/** Remove every occurrence of the token (raw, base64, url-encoded, and `user:secret` parts). */
export function redact(text: string, token: string): string {
  let out = text
  for (const s of secretsFor(token)) out = out.split(s).join('[REDACTED]')
  return out
}

function authHeaders(token: string, scheme: AuthScheme): Record<string, string> {
  if (!token) throw new ProviderError('INVALID_ARGUMENT', 'No access token configured.')
  if (/[\r\n\0]/.test(token)) throw new ProviderError('INVALID_ARGUMENT', 'The access token contains invalid characters.')
  switch (scheme) {
    case 'bearer':
      return { Authorization: `Bearer ${token}` }
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(token, 'utf8').toString('base64')}` }
    case 'private-token':
      return { 'PRIVATE-TOKEN': token }
  }
}

function resolveUrl(base: URL, path: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    let abs: URL
    try {
      abs = new URL(path)
    } catch {
      throw new ProviderError('BAD_RESPONSE', 'The server returned an invalid link.')
    }
    if (abs.origin !== base.origin) {
      throw new ProviderError('BAD_RESPONSE', `Refusing to follow a link to another host (${abs.host}).`)
    }
    return abs
  }
  if (!path.startsWith('/')) throw new ProviderError('INVALID_ARGUMENT', 'API path must start with "/".')
  const prefix = base.href.replace(/\/+$/, '')
  return new URL(prefix + path)
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const v = headers.get(name)
  if (v === null || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const ra = headers.get('retry-after')
  if (ra !== null) {
    const n = Number(ra)
    if (Number.isFinite(n)) return Math.max(0, Math.ceil(n))
    const date = Date.parse(ra)
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
  }
  const reset = headerNumber(headers, 'x-ratelimit-reset') ?? headerNumber(headers, 'ratelimit-reset')
  if (reset !== undefined) {
    // GitHub/GitLab send an epoch timestamp; small values are a delta in seconds.
    const nowSec = Math.floor(Date.now() / 1000)
    return reset > 1_000_000_000 ? Math.max(0, reset - nowSec) : Math.max(0, Math.ceil(reset))
  }
  return undefined
}

function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true
  if (status !== 403) return false
  return (
    headers.get('x-ratelimit-remaining') === '0' ||
    headers.get('ratelimit-remaining') === '0' ||
    headers.has('retry-after')
  )
}

/** Pull a human-readable message out of the error payloads of the four providers. */
function apiMessage(data: unknown): string {
  if (typeof data === 'string') return data
  if (!data || typeof data !== 'object') return ''
  const o = data as Record<string, unknown>
  const parts: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim())
    else if (Array.isArray(v)) v.forEach(push)
    else if (v && typeof v === 'object') {
      const inner = v as Record<string, unknown>
      if (typeof inner.message === 'string') push(inner.message)
      else parts.push(JSON.stringify(v))
    }
  }
  push(o.message) // GitHub, GitLab, Azure
  push(o.error_description)
  if (typeof o.error === 'string') push(o.error) // GitLab OAuth
  else if (o.error && typeof o.error === 'object') push((o.error as Record<string, unknown>).message) // Bitbucket
  if (Array.isArray(o.errors)) push(o.errors) // GitHub 422 details
  return parts.join('; ')
}

function errorForStatus(status: number, headers: Headers, data: unknown, label: string, token: string): ProviderError {
  const detail = redact(apiMessage(data), token).replace(/\s+/g, ' ').slice(0, 300)
  const suffix = detail ? ` ${label} said: ${detail}` : ''
  let code: ProviderErrorCode
  let message: string
  const retry = retryAfterSeconds(headers)
  if (isRateLimited(status, headers)) {
    code = 'RATE_LIMITED'
    message = `${label} rate limit reached${retry !== undefined ? `; try again in ${retry} s` : ''}.`
  } else if (status === 401) {
    code = 'UNAUTHORIZED'
    message = `${label} rejected the access token. Check that it is valid and has not expired.`
  } else if (status === 403) {
    code = 'FORBIDDEN'
    message = `The ${label} access token lacks permission for this request.`
  } else if (status === 404) {
    code = 'NOT_FOUND'
    message = `${label} could not find the resource, or the token has no access to it.`
  } else {
    code = 'BAD_RESPONSE'
    message = `${label} request failed with HTTP ${status}.`
  }
  return new ProviderError(code, message + suffix, {
    status,
    ...(code === 'RATE_LIMITED' && retry !== undefined ? { retryAfterSeconds: retry } : {}),
  })
}

async function readBody(res: Response): Promise<{ data: unknown; isJson: boolean }> {
  const text = await res.text()
  if (!text.trim()) return { data: null, isJson: true }
  try {
    return { data: JSON.parse(text) as unknown, isJson: true }
  } catch {
    return { data: text.slice(0, 300), isJson: false }
  }
}

/**
 * Perform an authenticated JSON request against a provider API.
 *
 * - The token is only ever placed in a request header; error messages are redacted.
 * - Redirects are followed manually and only within the same origin (GET only), so custom
 *   auth headers are never replayed to another host.
 * - Errors are thrown as ProviderError with a mapped code.
 */
export async function providerFetch<T = unknown>(opts: ProviderFetchOptions): Promise<ProviderResponse<T>> {
  const label = opts.label ?? 'Provider'
  const base = assertAllowedBaseUrl(opts.baseUrl)
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'GitBob',
    ...opts.headers,
    ...authHeaders(opts.token, opts.authScheme),
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers['Content-Type'] = 'application/json'
  }

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  let url = resolveUrl(base, opts.path)
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, { method, headers, body, signal, redirect: 'manual' })
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        await res.body?.cancel().catch(() => undefined)
        const next = new URL(res.headers.get('location')!, url)
        if (next.origin !== base.origin || (method !== 'GET' && res.status !== 307 && res.status !== 308)) {
          throw new ProviderError('BAD_RESPONSE', `${label} redirected the request to ${next.host}; not following it.`, {
            status: res.status,
          })
        }
        if (hop >= MAX_REDIRECTS) throw new ProviderError('BAD_RESPONSE', `${label} redirected too many times.`)
        url = next
        continue
      }
      const { data, isJson } = await readBody(res)
      if (!res.ok) throw errorForStatus(res.status, res.headers, data, label, opts.token)
      if (!isJson) {
        // Azure DevOps answers an invalid PAT with 203 + an HTML sign-in page.
        if (res.status === 203) {
          throw new ProviderError('UNAUTHORIZED', `${label} rejected the access token (sign-in page returned).`, {
            status: 203,
          })
        }
        throw new ProviderError('BAD_RESPONSE', `${label} returned a response that is not JSON.`, { status: res.status })
      }
      return { status: res.status, headers: res.headers, data: data as T, url: url.href }
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e
    if (timeout.aborted) {
      const ms = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const took = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`
      throw new ProviderError('NETWORK', `${label} did not respond within ${took}.`)
    }
    if (opts.signal?.aborted) throw new ProviderError('NETWORK', `${label} request was cancelled.`)
    const cause = (e as { cause?: { code?: unknown } } | null)?.cause
    const causeCode = cause && typeof cause.code === 'string' ? ` (${cause.code})` : ''
    throw new ProviderError('NETWORK', redact(`Could not reach ${url.host}${causeCode}.`, opts.token))
  }
}

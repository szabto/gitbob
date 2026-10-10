import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertAllowedBaseUrl, providerFetch, redact } from '../../src/providers/client'
import { ProviderError } from '../../src/providers/types'
import { refusedBaseUrl, startFakeApi, type FakeApi } from './fakeServer'

const TOKEN = 'tok_SUPERSECRET_1234567890'

let api: FakeApi
beforeEach(async () => {
  api = await startFakeApi({ isAuthorized: (h) => h.authorization === `Bearer ${TOKEN}` })
})
afterEach(async () => {
  await api.close()
})

async function fetchErr(path: string, extra: Partial<Parameters<typeof providerFetch>[0]> = {}): Promise<ProviderError> {
  try {
    await providerFetch({ baseUrl: api.baseUrl, path, token: TOKEN, authScheme: 'bearer', label: 'Test', ...extra })
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError)
    const err = e as ProviderError
    // Redaction is checked on every error path.
    expect(err.message).not.toContain(TOKEN)
    expect(JSON.stringify(err.toJSON())).not.toContain(TOKEN)
    return err
  }
  throw new Error('expected providerFetch to fail')
}

describe('providerFetch', () => {
  it('sends the auth header, parses JSON and exposes headers', async () => {
    api.route('GET /thing', (req) => ({ body: { ok: true, q: req.query.get('a') }, headers: { 'x-test': '1' } }))
    const res = await providerFetch<{ ok: boolean; q: string }>({
      baseUrl: api.baseUrl,
      path: '/thing?a=b',
      token: TOKEN,
      authScheme: 'bearer',
    })
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ ok: true, q: 'b' })
    expect(res.headers.get('x-test')).toBe('1')
    expect(api.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('supports basic and private-token schemes', async () => {
    const seen: Record<string, string | string[] | undefined>[] = []
    await api.close()
    api = await startFakeApi({
      isAuthorized: (h) => {
        seen.push({ ...h })
        return true
      },
      routes: { 'GET /x': () => ({ body: {} }) },
    })
    await providerFetch({ baseUrl: api.baseUrl, path: '/x', token: 'user:secret', authScheme: 'basic' })
    await providerFetch({ baseUrl: api.baseUrl, path: '/x', token: 'glpat-1', authScheme: 'private-token' })
    expect(seen[0]!.authorization).toBe(`Basic ${Buffer.from('user:secret').toString('base64')}`)
    expect(seen[1]!['private-token']).toBe('glpat-1')
    expect(seen[1]!.authorization).toBeUndefined()
  })

  it('serialises JSON bodies', async () => {
    api.route('POST /items', (req) => ({ status: 201, body: { received: req.body } }))
    const res = await providerFetch<{ received: unknown }>({
      baseUrl: api.baseUrl,
      path: '/items',
      method: 'POST',
      token: TOKEN,
      authScheme: 'bearer',
      body: { a: 1 },
    })
    expect(res.data.received).toEqual({ a: 1 })
    expect(api.requests[0]!.headers['content-type']).toBe('application/json')
  })

  it('returns null for an empty body', async () => {
    api.route('DELETE /x', () => ({ status: 204 }))
    const res = await providerFetch({ baseUrl: api.baseUrl, path: '/x', method: 'DELETE', token: TOKEN, authScheme: 'bearer' })
    expect(res.data).toBeNull()
  })

  it('maps 401 to UNAUTHORIZED', async () => {
    const err = await fetchErr('/x', { token: 'wrong-token-value' })
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.status).toBe(401)
    expect(err.message).toContain('Bad credentials')
  })

  it('maps 403 with rate-limit headers to RATE_LIMITED', async () => {
    const reset = Math.floor(Date.now() / 1000) + 60
    api.route('GET /x', () => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      body: { message: 'API rate limit exceeded' },
    }))
    const err = await fetchErr('/x')
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.retryAfterSeconds).toBeGreaterThan(50)
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it('maps 403 with retry-after (secondary limit) and 429 to RATE_LIMITED', async () => {
    api.route('GET /a', () => ({ status: 403, headers: { 'retry-after': '30' }, body: { message: 'secondary' } }))
    api.route('GET /b', () => ({ status: 429, body: {} }))
    const a = await fetchErr('/a')
    expect(a.code).toBe('RATE_LIMITED')
    expect(a.retryAfterSeconds).toBe(30)
    expect((await fetchErr('/b')).code).toBe('RATE_LIMITED')
  })

  it('maps a plain 403 to FORBIDDEN', async () => {
    api.route('GET /x', () => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '4999' },
      body: { message: 'Resource not accessible by personal access token' },
    }))
    const err = await fetchErr('/x')
    expect(err.code).toBe('FORBIDDEN')
    expect(err.message).toContain('Resource not accessible')
  })

  it('maps 404 to NOT_FOUND and 500 to BAD_RESPONSE', async () => {
    api.route('GET /boom', () => ({ status: 500, body: { message: 'Internal error' } }))
    expect((await fetchErr('/missing')).code).toBe('NOT_FOUND')
    const e = await fetchErr('/boom')
    expect(e.code).toBe('BAD_RESPONSE')
    expect(e.status).toBe(500)
  })

  it('maps non-JSON success responses to BAD_RESPONSE and Azure-style 203 HTML to UNAUTHORIZED', async () => {
    api.route('GET /html', () => ({ raw: '<html>hi</html>' }))
    api.route('GET /signin', () => ({ status: 203, raw: '<html>Sign in</html>' }))
    expect((await fetchErr('/html')).code).toBe('BAD_RESPONSE')
    expect((await fetchErr('/signin')).code).toBe('UNAUTHORIZED')
  })

  it('times out hanging requests with NETWORK', async () => {
    api.route('GET /slow', () => 'hang')
    const err = await fetchErr('/slow', { timeoutMs: 150 })
    expect(err.code).toBe('NETWORK')
    expect(err.message).toMatch(/did not respond within 150 ms/)
  })

  it('reports cancellation via the caller signal', async () => {
    api.route('GET /slow', () => 'hang')
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 50)
    const err = await fetchErr('/slow', { signal: ctl.signal })
    expect(err.code).toBe('NETWORK')
    expect(err.message).toMatch(/cancelled/)
  })

  it('maps connection refused to NETWORK', async () => {
    const base = await refusedBaseUrl()
    const err = await fetchErr('/x', { baseUrl: base })
    expect(err.code).toBe('NETWORK')
    expect(err.message).toMatch(/Could not reach 127\.0\.0\.1:\d+/)
  })

  it('redacts the token when the server echoes it back', async () => {
    api.route('GET /echo', (req) => ({
      status: 422,
      body: { message: `invalid token ${String(req.headers.authorization)}`, errors: [{ message: TOKEN }] },
    }))
    const err = await fetchErr('/echo')
    expect(err.code).toBe('BAD_RESPONSE')
    expect(err.message).toContain('[REDACTED]')
  })

  it('redacts basic credentials (raw, base64 and parts)', () => {
    const tok = 'alice:app-password-xyz'
    const b64 = Buffer.from(tok).toString('base64')
    const out = redact(`a ${tok} b ${b64} c app-password-xyz`, tok)
    expect(out).not.toContain('app-password-xyz')
    expect(out).not.toContain(b64)
  })

  it('follows same-origin GET redirects only', async () => {
    api.route('GET /old', () => ({ status: 301, headers: { location: '/new' } }))
    api.route('GET /new', () => ({ body: { moved: true } }))
    api.route('GET /away', () => ({ status: 302, headers: { location: 'https://evil.example/steal' } }))
    const res = await providerFetch({ baseUrl: api.baseUrl, path: '/old', token: TOKEN, authScheme: 'bearer' })
    expect(res.data).toEqual({ moved: true })
    const err = await fetchErr('/away')
    expect(err.code).toBe('BAD_RESPONSE')
    expect(err.message).toContain('evil.example')
  })

  it('refuses absolute links to other origins (pagination)', async () => {
    const err = await fetchErr('https://evil.example/next?page=2')
    expect(err.code).toBe('BAD_RESPONSE')
    expect(api.requests).toHaveLength(0)
  })

  it('rejects tokens that would inject headers', async () => {
    const err = await fetchErr('/x', { token: 'abc\r\nX-Evil: 1' })
    expect(err.code).toBe('INVALID_ARGUMENT')
    const empty = await fetchErr('/x', { token: '' })
    expect(empty.code).toBe('INVALID_ARGUMENT')
  })
})

describe('assertAllowedBaseUrl', () => {
  it.each(['https://api.github.com', 'http://127.0.0.1:1234', 'http://localhost:9/api'])('allows %s', (u) => {
    expect(() => assertAllowedBaseUrl(u)).not.toThrow()
  })
  it.each(['http://api.github.com', 'ftp://x', 'https://user:pw@api.github.com', 'not a url', 'http://10.0.0.1'])(
    'rejects %s',
    (u) => {
      expect(() => assertAllowedBaseUrl(u)).toThrow(ProviderError)
    },
  )
})

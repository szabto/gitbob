import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pollDeviceFlow, startDeviceFlow } from '../../src/providers/oauth'
import { catchErr, startFakeApi, type FakeApi, type FakeResponse } from './fakeServer'

const CLIENT_ID = 'Iv1.0123456789abcdef'
const DEVICE_CODE = '3584d83530557fdd1f46af8289938c8ef79f9dc5'
const ACCESS_TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a'

let api: FakeApi
beforeEach(async () => {
  api = await startFakeApi({ isAuthorized: () => true })
})
afterEach(async () => {
  await api.close()
})

function form(body: unknown): URLSearchParams {
  return new URLSearchParams(typeof body === 'string' ? body : '')
}

/** Answers the token endpoint with the given responses in order (last one repeats). */
function tokenSequence(responses: FakeResponse[]): void {
  let i = 0
  api.route('POST /login/oauth/access_token', () => responses[Math.min(i++, responses.length - 1)]!)
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = []
  return { waits, sleep: async (ms) => void waits.push(ms) }
}

describe('startDeviceFlow', () => {
  it('requests a device code with client_id and scope', async () => {
    api.route('POST /login/device/code', () => ({
      body: {
        device_code: DEVICE_CODE,
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    }))
    const r = await startDeviceFlow({ clientId: CLIENT_ID, scope: 'repo read:user', baseUrl: api.baseUrl })
    expect(r).toEqual({
      deviceCode: DEVICE_CODE,
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    })
    const req = api.requests[0]!
    expect(req.headers.accept).toBe('application/json')
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(req.headers.authorization).toBeUndefined()
    expect(Object.fromEntries(form(req.body))).toEqual({ client_id: CLIENT_ID, scope: 'repo read:user' })
  })

  it.each(['http://github.com/login/device', 'javascript:alert(1)', 'file:///etc/passwd', ''])(
    'rejects an unsafe verification URI %j',
    async (uri) => {
      api.route('POST /login/device/code', () => ({
        body: { device_code: DEVICE_CODE, user_code: 'X', verification_uri: uri, expires_in: 900, interval: 5 },
      }))
      await expect(startDeviceFlow({ clientId: CLIENT_ID, scope: 'repo', baseUrl: api.baseUrl })).rejects.toMatchObject({
        code: 'BAD_RESPONSE',
      })
    },
  )

  it('maps OAuth errors and validates input', async () => {
    api.route('POST /login/device/code', () => ({ status: 400, body: { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled' } }))
    await expect(startDeviceFlow({ clientId: CLIENT_ID, scope: 'repo', baseUrl: api.baseUrl })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(startDeviceFlow({ clientId: 'bad id!', scope: 'repo', baseUrl: api.baseUrl })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(startDeviceFlow({ clientId: CLIENT_ID, scope: 'repo', baseUrl: 'http://evil.example' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(api.requests).toHaveLength(1)
  })

  it('does not follow redirects', async () => {
    api.route('POST /login/device/code', () => ({ status: 302, headers: { location: 'https://evil.example/' }, body: {} }))
    await expect(startDeviceFlow({ clientId: CLIENT_ID, scope: 'repo', baseUrl: api.baseUrl })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    })
  })
})

describe('pollDeviceFlow', () => {
  const base = (): { clientId: string; deviceCode: string; interval: number; expiresIn: number; baseUrl: string } => ({
    clientId: CLIENT_ID,
    deviceCode: DEVICE_CODE,
    interval: 5,
    expiresIn: 900,
    baseUrl: api.baseUrl,
  })

  it('waits through authorization_pending and slow_down, then returns the token', async () => {
    tokenSequence([
      { body: { error: 'authorization_pending', error_description: 'The authorization request is still pending.' } },
      { body: { error: 'slow_down', error_description: 'Too many requests.', interval: 10 } },
      { body: { error: 'authorization_pending' } },
      { body: { access_token: ACCESS_TOKEN, token_type: 'bearer', scope: 'repo,read:user' } },
    ])
    const { sleep, waits } = recordingSleep()
    const r = await pollDeviceFlow({ ...base(), sleep })
    expect(r).toEqual({ accessToken: ACCESS_TOKEN, scope: 'repo,read:user' })
    expect(waits).toEqual([5000, 5000, 10_000, 10_000])
    expect(api.requests).toHaveLength(4)
    expect(Object.fromEntries(form(api.requests[0]!.body))).toEqual({
      client_id: CLIENT_ID,
      device_code: DEVICE_CODE,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
  })

  it('adds 5 s on slow_down when no interval is suggested', async () => {
    tokenSequence([{ body: { error: 'slow_down' } }, { body: { access_token: ACCESS_TOKEN, scope: '' } }])
    const { sleep, waits } = recordingSleep()
    await pollDeviceFlow({ ...base(), sleep })
    expect(waits).toEqual([5000, 10_000])
  })

  it('maps access_denied to UNAUTHORIZED with a friendly message', async () => {
    tokenSequence([{ body: { error: 'access_denied', error_description: 'The authorization request was denied.' } }])
    const e = await catchErr(pollDeviceFlow({ ...base(), sleep: recordingSleep().sleep }))
    expect(e.code).toBe('UNAUTHORIZED')
    expect(e.message).toMatch(/denied/)
  })

  it('maps expired_token from the server', async () => {
    tokenSequence([{ body: { error: 'authorization_pending' } }, { body: { error: 'expired_token' } }])
    const e = await catchErr(pollDeviceFlow({ ...base(), sleep: recordingSleep().sleep }))
    expect(e.code).toBe('UNAUTHORIZED')
    expect(e.message).toMatch(/expired/)
  })

  it('gives up locally once expiresIn has elapsed', async () => {
    tokenSequence([{ body: { error: 'authorization_pending' } }])
    const e = await catchErr(pollDeviceFlow({ ...base(), expiresIn: 12, sleep: recordingSleep().sleep }))
    expect(e.message).toMatch(/expired/)
    // Polls at 5 s and 10 s; the third wait would pass 12 s.
    expect(api.requests).toHaveLength(2)
  })

  it('stops when the signal is aborted (during a wait and before starting)', async () => {
    tokenSequence([{ body: { error: 'authorization_pending' } }])
    const ctrl = new AbortController()
    let polls = 0
    const sleep = async (): Promise<void> => {
      if (++polls === 3) ctrl.abort()
    }
    const e = await catchErr(pollDeviceFlow({ ...base(), signal: ctrl.signal, sleep }))
    expect(e.code).toBe('NETWORK')
    expect(e.message).toMatch(/cancelled/)
    expect(api.requests).toHaveLength(2)

    const e2 = await catchErr(pollDeviceFlow({ ...base(), signal: ctrl.signal }))
    expect(e2.message).toMatch(/cancelled/)
    expect(api.requests).toHaveLength(2)
  })

  it('cancels the default (real) sleep promptly', async () => {
    tokenSequence([{ body: { error: 'authorization_pending' } }])
    const ctrl = new AbortController()
    const started = Date.now()
    setTimeout(() => ctrl.abort(), 20)
    const e = await catchErr(pollDeviceFlow({ ...base(), interval: 60, signal: ctrl.signal }))
    expect(e.message).toMatch(/cancelled/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(api.requests).toHaveLength(0)
  })

  it('never puts the token or device code in error messages', async () => {
    tokenSequence([
      {
        body: {
          error: 'weird_error',
          error_description: `bad device ${DEVICE_CODE} and token ${ACCESS_TOKEN}`,
        },
      },
    ])
    const e = await catchErr(pollDeviceFlow({ ...base(), sleep: recordingSleep().sleep }))
    expect(e.code).toBe('BAD_RESPONSE')
    expect(e.message).not.toContain(DEVICE_CODE)
    expect(e.message).not.toContain(ACCESS_TOKEN)
    expect(JSON.stringify(e.toJSON())).not.toContain(DEVICE_CODE)

    // A malformed token is rejected without echoing it.
    tokenSequence([{ body: { access_token: `${ACCESS_TOKEN} injected`, scope: 'repo' } }])
    const e2 = await catchErr(pollDeviceFlow({ ...base(), sleep: recordingSleep().sleep }))
    expect(e2.message).not.toContain(ACCESS_TOKEN)

    // Non-JSON / server errors do not echo the body.
    api.route('POST /login/oauth/access_token', () => ({ status: 500, raw: `<html>${ACCESS_TOKEN}</html>` }))
    const e3 = await catchErr(pollDeviceFlow({ ...base(), sleep: recordingSleep().sleep }))
    expect(e3.message).not.toContain(ACCESS_TOKEN)
  })

  it('validates the device code and client id without a request', async () => {
    await expect(pollDeviceFlow({ ...base(), deviceCode: 'has space' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(pollDeviceFlow({ ...base(), clientId: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
  })
})

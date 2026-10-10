import { assertAllowedBaseUrl, redact } from './client'
import { ProviderError } from './types'
import { safeWebUrl } from './util'

/**
 * GitHub OAuth Device Flow (RFC 8628 as implemented by GitHub). Needs only the OAuth app's
 * client id — no client secret — so it is safe to run in a desktop app.
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

const DEFAULT_BASE = 'https://github.com'
const DEFAULT_TIMEOUT_MS = 20_000
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,100}$/
// eslint-disable-next-line no-control-regex
const SCOPE_RE = /^[^\0-\x1f\x7f]{0,1000}$/
const DEVICE_CODE_RE = /^[\x21-\x7e]{1,512}$/

export interface DeviceFlowStart {
  deviceCode: string
  /** Code the user types at verificationUri. */
  userCode: string
  /** https page where the user enters userCode. */
  verificationUri: string
  /** Seconds until deviceCode expires. */
  expiresIn: number
  /** Minimum seconds between polls. */
  interval: number
}

export interface StartDeviceFlowOptions {
  clientId: string
  /** Space-separated OAuth scopes, e.g. "repo read:user". */
  scope: string
  /** Web base URL, default https://github.com (GitHub Enterprise Server: https://host). */
  baseUrl?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface PollDeviceFlowOptions {
  clientId: string
  deviceCode: string
  interval: number
  expiresIn: number
  baseUrl?: string
  signal?: AbortSignal
  /** Injectable for tests; default is an abortable setTimeout. */
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

export interface DeviceFlowToken {
  accessToken: string
  /** Scopes actually granted (may differ from those requested). */
  scope: string
}

function assertClientId(clientId: string): void {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) {
    throw new ProviderError('INVALID_ARGUMENT', 'Invalid OAuth client id.')
  }
}

function cancelled(): ProviderError {
  return new ProviderError('NETWORK', 'GitHub sign-in was cancelled.')
}

function defaultSleep(signal: AbortSignal | undefined): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(cancelled())
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(t)
        reject(cancelled())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/** POST an x-www-form-urlencoded body and parse the JSON answer. Never follows redirects. */
async function postForm(
  url: URL,
  params: Record<string, string>,
  secrets: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const scrub = (s: string): string => secrets.reduce((acc, sec) => (sec ? redact(acc, sec) : acc), s)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'GitBob',
      },
      body: new URLSearchParams(params).toString(),
      signal,
      redirect: 'manual',
    })
  } catch (e) {
    if (opts.signal?.aborted) throw cancelled()
    if (timeout.aborted) throw new ProviderError('NETWORK', 'GitHub did not respond in time.')
    const cause = (e as { cause?: { code?: unknown } } | null)?.cause
    const code = cause && typeof cause.code === 'string' ? ` (${cause.code})` : ''
    throw new ProviderError('NETWORK', scrub(`Could not reach ${url.host}${code}.`))
  }
  let text: string
  try {
    text = await res.text()
  } catch {
    if (opts.signal?.aborted) throw cancelled()
    throw new ProviderError('NETWORK', 'GitHub closed the connection.')
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ProviderError('BAD_RESPONSE', 'GitHub redirected the sign-in request; not following it.', { status: res.status })
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    if (res.status === 404) {
      throw new ProviderError('NOT_FOUND', 'GitHub device sign-in is not available at this address.', { status: 404 })
    }
    throw new ProviderError('BAD_RESPONSE', `GitHub returned an unexpected sign-in response (HTTP ${res.status}).`, {
      status: res.status,
    })
  }
  return { status: res.status, data: data as Record<string, unknown> }
}

function oauthError(data: Record<string, unknown>, status: number, secrets: string[]): ProviderError {
  const err = typeof data.error === 'string' ? data.error : ''
  const rawDesc = typeof data.error_description === 'string' ? data.error_description : ''
  const desc = secrets
    .reduce((acc, s) => (s ? redact(acc, s) : acc), rawDesc)
    // Never echo anything shaped like a GitHub token, even one we do not know.
    .replace(/\bgh[opsur]_[A-Za-z0-9_]{16,}/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
  const opts = status >= 400 ? { status } : {}
  switch (err) {
    case 'access_denied':
      return new ProviderError('UNAUTHORIZED', 'GitHub sign-in was denied. Start again and choose "Authorize" to connect.', opts)
    case 'expired_token':
      return new ProviderError('UNAUTHORIZED', 'The GitHub sign-in code expired before it was entered. Start again for a new code.', opts)
    case 'incorrect_client_credentials':
    case 'unauthorized_client':
      return new ProviderError('INVALID_ARGUMENT', 'GitHub does not recognise this OAuth app client id.', opts)
    case 'device_flow_disabled':
      return new ProviderError('FORBIDDEN', 'Device sign-in is not enabled for this GitHub OAuth app.', opts)
    case 'incorrect_device_code':
      return new ProviderError('INVALID_ARGUMENT', 'GitHub did not recognise the sign-in code. Start again.', opts)
    default:
      return new ProviderError(
        'BAD_RESPONSE',
        `GitHub sign-in failed${err ? ` (${err.replace(/[^\w.-]/g, '').slice(0, 60)})` : ''}${desc ? `: ${desc}` : '.'}`,
        opts,
      )
  }
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : fallback
}

/** Step 1: get a device code and the user code to show. POST {base}/login/device/code. */
export async function startDeviceFlow(opts: StartDeviceFlowOptions): Promise<DeviceFlowStart> {
  assertClientId(opts?.clientId)
  if (typeof opts.scope !== 'string' || !SCOPE_RE.test(opts.scope)) {
    throw new ProviderError('INVALID_ARGUMENT', 'Invalid OAuth scope.')
  }
  const base = assertAllowedBaseUrl(opts.baseUrl ?? DEFAULT_BASE)
  const url = new URL(base.href.replace(/\/+$/, '') + '/login/device/code')
  const { status, data } = await postForm(url, { client_id: opts.clientId, scope: opts.scope }, [], opts)
  if (typeof data.error === 'string' || status >= 400) throw oauthError(data, status, [])
  const deviceCode = typeof data.device_code === 'string' ? data.device_code : ''
  const userCode = typeof data.user_code === 'string' ? data.user_code : ''
  const rawUri = typeof data.verification_uri === 'string' ? data.verification_uri : ''
  const verificationUri = safeWebUrl(rawUri)
  if (!deviceCode || !userCode) throw new ProviderError('BAD_RESPONSE', 'GitHub returned an incomplete sign-in response.')
  if (!verificationUri || !verificationUri.startsWith('https:')) {
    throw new ProviderError('BAD_RESPONSE', 'GitHub returned an unsafe verification address.')
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: positiveInt(data.expires_in, 900),
    interval: positiveInt(data.interval, 5),
  }
}

/**
 * Step 2: poll until the user authorises (or denies) the device. Waits `interval` seconds
 * between polls, adds 5 s on `slow_down`, and stops after `expiresIn` seconds or on abort.
 */
export async function pollDeviceFlow(opts: PollDeviceFlowOptions): Promise<DeviceFlowToken> {
  assertClientId(opts?.clientId)
  if (typeof opts.deviceCode !== 'string' || !DEVICE_CODE_RE.test(opts.deviceCode)) {
    throw new ProviderError('INVALID_ARGUMENT', 'Invalid device code.')
  }
  const base = assertAllowedBaseUrl(opts.baseUrl ?? DEFAULT_BASE)
  const url = new URL(base.href.replace(/\/+$/, '') + '/login/oauth/access_token')
  const sleep = opts.sleep ?? defaultSleep(opts.signal)
  let intervalSec = Math.max(1, positiveInt(opts.interval, 5))
  const expiresSec = positiveInt(opts.expiresIn, 900)
  const started = Date.now()
  let waited = 0
  const secrets = [opts.deviceCode]

  for (;;) {
    if (opts.signal?.aborted) throw cancelled()
    // Wait first: GitHub rejects polls faster than `interval` with slow_down.
    await sleep(intervalSec * 1000)
    waited += intervalSec * 1000
    if (opts.signal?.aborted) throw cancelled()
    if (Math.max(waited, Date.now() - started) > expiresSec * 1000) {
      throw oauthError({ error: 'expired_token' }, 0, secrets)
    }

    const { status, data } = await postForm(
      url,
      { client_id: opts.clientId, device_code: opts.deviceCode, grant_type: DEVICE_GRANT },
      secrets,
      opts,
    )
    const token = typeof data.access_token === 'string' ? data.access_token : ''
    if (token) {
      if (/[\s\0]/.test(token)) throw new ProviderError('BAD_RESPONSE', 'GitHub returned a malformed access token.')
      return { accessToken: token, scope: typeof data.scope === 'string' ? data.scope : '' }
    }
    const err = typeof data.error === 'string' ? data.error : ''
    if (err === 'authorization_pending') continue
    if (err === 'slow_down') {
      const suggested = positiveInt(data.interval, 0)
      intervalSec = Math.max(intervalSec + 5, suggested)
      continue
    }
    throw oauthError(data, status, secrets)
  }
}

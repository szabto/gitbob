import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Hosts avatars may be loaded from (after redirects). */
const ALLOWED_HOSTS = new Set(['avatars.githubusercontent.com', 'github.com', 'secure.gravatar.com', 'www.gravatar.com'])
const MAX_BYTES = 256 * 1024
const TTL_MS = 7 * 24 * 3600_000
const EMAIL_RE = /^[^\s@<>()]{1,128}@[^\s@<>()]{1,253}$/
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

export type AvatarRequest = { kind: 'email'; email: string; source: 'github' | 'gravatar' } | { kind: 'github-owner'; owner: string }

/**
 * Fetches avatar images in the main process and hands them to the renderer as data URLs, cached in
 * memory and on disk for a week. Only fixed avatar hosts are contacted, never anything a page names.
 */
export class AvatarService {
  private readonly dir: string
  private memory = new Map<string, string | null>()
  private inflight = new Map<string, Promise<string | null>>()

  constructor(userDataDir: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.dir = join(userDataDir, 'avatar-cache')
  }

  private url(req: AvatarRequest): string | null {
    if (req.kind === 'github-owner') return OWNER_RE.test(req.owner) ? `https://github.com/${req.owner}.png?size=64` : null
    const email = req.email.trim().toLowerCase()
    if (!EMAIL_RE.test(email)) return null
    if (req.source === 'github') return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=64`
    const hash = createHash('sha256').update(email).digest('hex')
    return `https://secure.gravatar.com/avatar/${hash}?s=64&d=404`
  }

  async get(req: AvatarRequest): Promise<string | null> {
    const url = this.url(req)
    if (!url) return null
    const key = createHash('sha256').update(url).digest('hex')
    if (this.memory.has(key)) return this.memory.get(key)!
    let p = this.inflight.get(key)
    if (!p) {
      p = this.load(key, url).finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    const v = await p
    this.memory.set(key, v)
    return v
  }

  private async load(key: string, url: string): Promise<string | null> {
    const file = join(this.dir, `${key}.json`)
    try {
      const cached = JSON.parse(await readFile(file, 'utf8')) as { at: number; data: string | null }
      if (Date.now() - cached.at < TTL_MS) return cached.data
    } catch {
      /* not cached */
    }
    const data = await this.download(url).catch(() => undefined)
    if (data === undefined) return null // network error: try again next time
    await mkdir(this.dir, { recursive: true }).catch(() => {})
    await writeFile(file, JSON.stringify({ at: Date.now(), data })).catch(() => {})
    return data
  }

  /** The image as a data URL, null if there is none (404), undefined on network failure. */
  private async download(url: string, redirects = 3): Promise<string | null | undefined> {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return null
    const res = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      return next && redirects > 0 ? this.download(new URL(next, url).href, redirects - 1) : null
    }
    if (res.status === 404) return null
    if (!res.ok) return undefined
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) return null
    return `data:${type};base64,${buf.toString('base64')}`
  }
}

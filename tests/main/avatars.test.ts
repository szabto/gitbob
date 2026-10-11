import { describe, expect, it, vi } from 'vitest'
import { AvatarService } from '../../src/main/avatars'
import { makeTempDir, cleanupFixtures } from '../helpers/fixture'
import { afterEach } from 'vitest'

afterEach(cleanupFixtures)

const png = (bytes = 10) => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } })

describe('AvatarService', () => {
  it('fetches GitHub avatars by email and caches them in memory and on disk', async () => {
    const dir = makeTempDir('gitbob-ud-')
    const fetchImpl = vi.fn(async () => png())
    const svc = new AvatarService(dir, fetchImpl as unknown as typeof fetch)
    const a = await svc.get({ kind: 'email', email: 'Ann@Example.com', source: 'github' })
    expect(a).toMatch(/^data:image\/png;base64,/)
    await svc.get({ kind: 'email', email: 'ann@example.com', source: 'github' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe('https://avatars.githubusercontent.com/u/e?email=ann%40example.com&s=64')
    // A new service (app restart) reads the disk cache.
    const again = new AvatarService(dir, fetchImpl as unknown as typeof fetch)
    expect(await again.get({ kind: 'email', email: 'ann@example.com', source: 'github' })).toBe(a)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('follows redirects only to allowed hosts and rejects non-images and huge files', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://github.com/acme.png')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/x.png' } })
      if (url.includes('big')) return png(300 * 1024)
      return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    })
    const svc = new AvatarService(makeTempDir('gitbob-ud-'), fetchImpl as unknown as typeof fetch)
    expect(await svc.get({ kind: 'github-owner', owner: 'acme' })).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1) // never contacted evil.example
    expect(await svc.get({ kind: 'email', email: 'big@x.io', source: 'github' })).toBeNull()
    expect(await svc.get({ kind: 'email', email: 'html@x.io', source: 'github' })).toBeNull()
  })

  it('rejects malformed owners and emails without any request', async () => {
    const fetchImpl = vi.fn(async () => png())
    const svc = new AvatarService(makeTempDir('gitbob-ud-'), fetchImpl as unknown as typeof fetch)
    expect(await svc.get({ kind: 'github-owner', owner: '../x' })).toBeNull()
    expect(await svc.get({ kind: 'email', email: 'not an email', source: 'github' })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses hashed emails for Gravatar and treats its 404 as no avatar', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }))
    const svc = new AvatarService(makeTempDir('gitbob-ud-'), fetchImpl as unknown as typeof fetch)
    expect(await svc.get({ kind: 'email', email: 'ann@example.com', source: 'gravatar' })).toBeNull()
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0])
    expect(url).toMatch(/^https:\/\/secure\.gravatar\.com\/avatar\/[0-9a-f]{64}\?s=64&d=404$/)
    expect(url).not.toContain('example.com')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { ProviderService } from '../../src/main/providers'
import type { TokenStore } from '../../src/main/tokens'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

/** Token store double: decrypting (get) would touch the OS keychain, so it must not be called. */
function store(saved: string[]) {
  const calls: string[] = []
  const fake = {
    canStore: () => true,
    has: async (k: string) => saved.includes(k),
    get: async (k: string) => {
      calls.push(k)
      throw new Error('keychain must not be touched when only checking the status')
    },
    set: async () => {},
    delete: async () => {},
  }
  return { fake: fake as unknown as TokenStore, calls }
}

describe('ProviderService.status', () => {
  it('reports a connected account without decrypting its token', async () => {
    const repo = createFixtureRepo()
    repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
    const { fake, calls } = store(['github:github.com'])
    const status = await new ProviderService(fake).status(repo.dir)
    expect(status).toMatchObject({ connected: true, remote: 'origin', repo: { kind: 'github', owner: 'acme', repo: 'widgets' } })
    expect(calls).toEqual([])
  })

  it('reports not connected and no provider for other remotes', async () => {
    const repo = createFixtureRepo()
    repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
    expect((await new ProviderService(store([]).fake).status(repo.dir)).connected).toBe(false)
    const other = createFixtureRepo()
    other.git(['remote', 'add', 'origin', 'https://example.org/x.git'])
    expect((await new ProviderService(store([]).fake).status(other.dir)).repo).toBeNull()
  })
})

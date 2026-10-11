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
    keys: async () => saved,
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

  it('offers GitHub sign-in only when a client id exists for the repository host', async () => {
    const repo = createFixtureRepo()
    repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
    const hosts: string[] = []
    const builtin = (host: string) => (hosts.push(host), host === 'github.com' ? 'Ov23liTEST' : null)
    expect((await new ProviderService(store([]).fake, builtin).status(repo.dir)).canSignIn).toBe(true)
    expect(hosts).toEqual(['github.com'])
    expect((await new ProviderService(store([]).fake).status(repo.dir)).canSignIn).toBe(false)
    const gitlab = createFixtureRepo()
    gitlab.git(['remote', 'add', 'origin', 'https://gitlab.com/acme/widgets.git'])
    expect((await new ProviderService(store([]).fake, builtin).status(gitlab.dir)).canSignIn).toBe(false)
  })
})

describe('ProviderService.accounts', () => {
  it('lists saved accounts from token keys without decrypting them', async () => {
    const { fake, calls } = store(['gitlab:gitlab.example.com', 'github:github.com', 'junk', 'azure:dev.azure.com'])
    expect(await new ProviderService(fake).accounts()).toEqual([
      { kind: 'azure', host: 'dev.azure.com' },
      { kind: 'github', host: 'github.com' },
      { kind: 'gitlab', host: 'gitlab.example.com' },
    ])
    expect(calls).toEqual([])
  })
})

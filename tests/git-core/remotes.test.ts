import { afterEach, describe, expect, it } from 'vitest'
import { addRemote, fetch, listRemotes, pull, push, removeRemote } from '@git-core/remotes'
import { listRefs } from '@git-core/refs'
import { cleanupFixtures, cloneFixtureRepo, createFixtureRepo, type FixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

/** A bare "server" repository seeded with one commit, plus two independent clones. */
function setup(): { server: FixtureRepo; alice: FixtureRepo; bob: FixtureRepo } {
  const seed = createFixtureRepo()
  seed.commit('seed', { 'f.txt': '1\n' })
  const server = createFixtureRepo({ bare: true })
  seed.git(['push', '-q', server.dir, 'main'])
  return { server, alice: cloneFixtureRepo(server), bob: cloneFixtureRepo(server) }
}

describe('remotes', () => {
  it('lists, adds and removes remotes', async () => {
    const { server, alice } = setup()
    expect(await listRemotes(alice.dir)).toEqual([{ name: 'origin', fetchUrl: server.dir, pushUrl: server.dir }])
    await addRemote(alice.dir, 'mirror', server.dir)
    expect((await listRemotes(alice.dir)).map((r) => r.name)).toEqual(['mirror', 'origin'])
    await removeRemote(alice.dir, 'mirror')
    expect((await listRemotes(alice.dir)).map((r) => r.name)).toEqual(['origin'])
  })

  it('rejects invalid remote names and urls', async () => {
    const { alice, server } = setup()
    await expect(addRemote(alice.dir, '-x', server.dir)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(addRemote(alice.dir, 'ok', '--upload-pack=evil')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(addRemote(alice.dir, 'ok', 'a b')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(fetch(alice.dir, { remote: '../x', prune: false })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('pushes a new branch with upstream, then fetches it elsewhere', async () => {
    const { alice, bob } = setup()
    alice.git(['switch', '-q', '-c', 'feature'])
    const sha = alice.commit('feature work', { 'g.txt': 'g' })
    await push(alice.dir, { branch: 'feature', remote: 'origin', setUpstream: true, force: 'none' })
    expect(alice.git(['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).toBe('origin/feature')

    await fetch(bob.dir, { prune: false })
    const remoteRef = (await listRefs(bob.dir)).find((r) => r.name === 'refs/remotes/origin/feature')
    expect(remoteRef?.target).toBe(sha)
  })

  it('fetch --prune removes deleted remote branches', async () => {
    const { alice, bob } = setup()
    alice.git(['push', '-q', 'origin', 'main:refs/heads/tmp'])
    await fetch(bob.dir, { prune: false })
    expect((await listRefs(bob.dir)).map((r) => r.name)).toContain('refs/remotes/origin/tmp')
    alice.git(['push', '-q', 'origin', '--delete', 'tmp'])
    await fetch(bob.dir, { prune: true })
    expect((await listRefs(bob.dir)).map((r) => r.name)).not.toContain('refs/remotes/origin/tmp')
  })

  it('pull fast-forwards, and ff-only refuses diverged history with a clear message', async () => {
    const { alice, bob } = setup()
    const a1 = alice.commit('alice 1', { 'a.txt': '1' })
    alice.git(['push', '-q'])
    await pull(bob.dir, { mode: 'ff-only' })
    expect(bob.head()).toBe(a1)

    alice.commit('alice 2', { 'a.txt': '2' })
    alice.git(['push', '-q'])
    bob.commit('bob 1', { 'b.txt': '1' })
    await expect(pull(bob.dir, { mode: 'ff-only' })).rejects.toThrow(/diverged/)

    await pull(bob.dir, { mode: 'rebase' })
    expect(bob.git(['rev-list', '--count', 'HEAD'])).toBe('4')
    expect(bob.git(['log', '-1', '--format=%s'])).toBe('bob 1')
    expect(bob.git(['rev-list', '--merges', '--count', 'HEAD'])).toBe('0')
  })

  it('pull with merge creates a merge commit', async () => {
    const { alice, bob } = setup()
    alice.commit('alice', { 'a.txt': '1' })
    alice.git(['push', '-q'])
    bob.commit('bob', { 'b.txt': '1' })
    await pull(bob.dir, { mode: 'merge' })
    expect(bob.git(['rev-list', '--merges', '--count', 'HEAD'])).toBe('1')
  })

  it('pull without upstream explains the problem', async () => {
    const { alice } = setup()
    alice.git(['switch', '-q', '-c', 'lonely'])
    await expect(pull(alice.dir, { mode: 'ff-only' })).rejects.toThrow(/no upstream/)
  })

  it('rejected push is reported, force-with-lease overwrites only with a current lease', async () => {
    const { alice, bob } = setup()
    alice.commit('alice', { 'a.txt': '1' })
    alice.git(['push', '-q'])
    bob.commit('bob', { 'b.txt': '1' })
    await expect(push(bob.dir, { branch: 'main', remote: 'origin', setUpstream: false, force: 'none' })).rejects.toThrow(
      /Pull first/,
    )
    // Bob has a stale lease (has not fetched alice's commit), so with-lease must refuse.
    await expect(
      push(bob.dir, { branch: 'main', remote: 'origin', setUpstream: false, force: 'with-lease' }),
    ).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await fetch(bob.dir, { prune: false })
    await push(bob.dir, { branch: 'main', remote: 'origin', setUpstream: false, force: 'with-lease' })
    expect(bob.git(['rev-parse', 'origin/main'])).toBe(bob.head())
  })

  it('authentication failures do not hang and are explained', async () => {
    const { alice } = setup()
    // An HTTPS remote on a closed local port fails immediately without prompting.
    alice.git(['remote', 'add', 'dead', 'https://127.0.0.1:9/repo.git'])
    const started = Date.now()
    await expect(fetch(alice.dir, { remote: 'dead', prune: false })).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(Date.now() - started).toBeLessThan(20_000)
  })
})

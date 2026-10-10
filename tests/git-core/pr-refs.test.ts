import { afterEach, describe, expect, it } from 'vitest'
import { GitError } from '@git-core/errors'
import { deletePullRequestRef, fetchPullRequestRef, listPullRequestRefs } from '@git-core/pr-refs'
import { cleanupFixtures, cloneFixtureRepo, createSeededBareRepo, type FixtureRepo } from '../helpers/fixture'

afterEach(() => cleanupFixtures())

async function expectGitError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => new Error('expected rejection'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).code).toBe(code)
}

/** A bare "server" with a PR head at refs/pull/7/head (not on any branch), and a clone of it. */
function setup(): { bare: FixtureRepo; seed: FixtureRepo; clone: FixtureRepo; prSha: string } {
  const { bare, seed } = createSeededBareRepo(2)
  seed.checkout('feature')
  const prSha = seed.commit('pr work', { 'pr.txt': 'from the PR\n' })
  seed.git(['push', '-q', bare.dir, `${prSha}:refs/pull/7/head`])
  seed.checkout('main')
  const clone = cloneFixtureRepo(bare)
  return { bare, seed, clone, prSha }
}

describe('pull request refs', () => {
  it('fetches a PR head into refs/gitbob/pr/<n>, lists and deletes it', async () => {
    const { clone, prSha } = setup()
    // In a normal clone no ref reaches the PR commit.
    expect(clone.git(['rev-list', '--all']).split('\n')).not.toContain(prSha)

    const r = await fetchPullRequestRef(clone.dir, 'origin', 'refs/pull/7/head', 7)
    expect(r).toEqual({ ref: 'refs/gitbob/pr/7', sha: prSha })
    expect(clone.rev('refs/gitbob/pr/7')).toBe(prSha)
    // Diffable with the normal tools.
    expect(clone.git(['show', '--format=', '--name-only', r.ref])).toBe('pr.txt')
    // No branches, remote-tracking refs or tags were created.
    expect(clone.git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'])).not.toMatch(/pull|gitbob/)

    expect(await listPullRequestRefs(clone.dir)).toEqual([{ number: 7, ref: 'refs/gitbob/pr/7', sha: prSha }])
    expect(await deletePullRequestRef(clone.dir, 7)).toBe(true)
    expect(await listPullRequestRefs(clone.dir)).toEqual([])
    expect(await deletePullRequestRef(clone.dir, 7)).toBe(false)
  })

  it('follows a force-pushed PR on re-fetch and supports GitLab merge request refs', async () => {
    const { bare, seed, clone, prSha } = setup()
    await fetchPullRequestRef(clone.dir, 'origin', 'refs/pull/7/head', 7)

    seed.checkout('main')
    const rewritten = seed.commit('rewritten PR', { 'pr.txt': 'rewritten\n' })
    seed.git(['push', '-q', '-f', bare.dir, `${rewritten}:refs/pull/7/head`])
    seed.git(['push', '-q', bare.dir, `${prSha}:refs/merge-requests/12/head`])

    expect((await fetchPullRequestRef(clone.dir, 'origin', 'refs/pull/7/head', 7)).sha).toBe(rewritten)
    expect(await fetchPullRequestRef(clone.dir, 'origin', 'refs/merge-requests/12/head', 12)).toEqual({
      ref: 'refs/gitbob/pr/12',
      sha: prSha,
    })
    expect((await listPullRequestRefs(clone.dir)).map((p) => p.number)).toEqual([7, 12])
  })

  it('reports a missing PR ref as NOT_FOUND', async () => {
    const { clone } = setup()
    await expectGitError(fetchPullRequestRef(clone.dir, 'origin', 'refs/pull/99/head', 99), 'NOT_FOUND')
    expect(await listPullRequestRefs(clone.dir)).toEqual([])
  })

  it('rejects invalid remotes, refspecs and numbers before running git', async () => {
    const { clone } = setup()
    const bad: [string, string, number][] = [
      ['-uorigin', 'refs/pull/1/head', 1],
      ['origin', 'refs/heads/main', 1],
      ['origin', 'refs/pull/1/head:refs/heads/main', 1],
      ['origin', '+refs/pull/1/head', 1],
      ['origin', 'refs/pull/1/head\n', 1],
      ['origin', 'refs/pull/x/head', 1],
      ['origin', 'refs/pull/1/head', 0],
      ['origin', 'refs/pull/1/head', -1],
      ['origin', 'refs/pull/1/head', 1.5],
      ['origin', 'refs/pull/1/head', Number.NaN],
    ]
    for (const [remote, src, n] of bad) {
      await expectGitError(fetchPullRequestRef(clone.dir, remote, src, n), 'INVALID_ARGUMENT')
    }
    await expectGitError(deletePullRequestRef(clone.dir, 0), 'INVALID_ARGUMENT')
    expect(await listPullRequestRefs(clone.dir)).toEqual([])
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { commitsToRebase, mergeRef, rebaseOnto } from '@git-core/history'
import { getOperation } from '@git-core/status'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

function diverged() {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1\n' })
  repo.branch('feature')
  repo.commit('main work', { 'm.txt': 'm\n' })
  repo.checkout('feature')
  const f1 = repo.commit('feature one', { 'f.txt': '1\n' })
  repo.commit('feature two', { 'f.txt': '2\n' })
  return { repo, f1 }
}

describe('merge and rebase onto a branch', () => {
  it('merges a branch with a merge commit, fast-forwards, and reports up to date', async () => {
    const { repo } = diverged()
    repo.checkout('main')
    expect(await mergeRef(repo.dir, 'refs/heads/feature', { mode: 'ff' })).toEqual({ fastForward: false, upToDate: false })
    expect(repo.git(['log', '-1', '--format=%s'])).toBe("Merge branch 'feature'")
    expect(repo.git(['rev-list', '--parents', '-n1', 'HEAD']).split(' ')).toHaveLength(3)
    expect(await mergeRef(repo.dir, 'refs/heads/feature', { mode: 'ff' })).toEqual({ fastForward: false, upToDate: true })

    repo.checkout('feature')
    expect(await mergeRef(repo.dir, 'refs/heads/main', { mode: 'ff-only' })).toEqual({ fastForward: true, upToDate: false })
    expect(repo.rev('feature')).toBe(repo.rev('main'))
  })

  it('ff-only refuses diverged histories and no-ff always creates a merge commit', async () => {
    const { repo } = diverged()
    repo.checkout('main')
    await expect(mergeRef(repo.dir, 'refs/heads/feature', { mode: 'ff-only' })).rejects.toThrow()
    expect(await getOperation(repo.dir)).toBeNull()
    repo.branch('behind', 'HEAD~1')
    repo.checkout('behind')
    await mergeRef(repo.dir, 'refs/heads/main', { mode: 'no-ff' })
    expect(repo.git(['rev-list', '--parents', '-n1', 'HEAD']).split(' ')).toHaveLength(3)
  })

  it('a conflicting merge stops with the merge in progress', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'c.txt': 'base\n' })
    repo.branch('other')
    repo.commit('ours', { 'c.txt': 'ours\n' })
    repo.checkout('other')
    repo.commit('theirs', { 'c.txt': 'theirs\n' })
    repo.checkout('main')
    await expect(mergeRef(repo.dir, 'refs/heads/other', { mode: 'ff' })).rejects.toThrow(/conflicts in c.txt/)
    expect(await getOperation(repo.dir)).toBe('merge')
  })

  it('rebases the current branch onto another and counts the commits it rewrites', async () => {
    const { repo } = diverged()
    expect(await commitsToRebase(repo.dir, 'refs/heads/main')).toBe(2)
    await rebaseOnto(repo.dir, 'refs/heads/main')
    expect(repo.git(['log', '--format=%s', '-3'])).toBe('feature two\nfeature one\nmain work')
    expect(await commitsToRebase(repo.dir, 'refs/heads/main')).toBe(2)
  })

  it('rejects refs that are not branches/tags or could be options', async () => {
    const { repo, f1 } = diverged()
    for (const bad of ['--abort', 'feature', f1, 'refs/heads/../x', 'refs/heads/missing']) {
      await expect(mergeRef(repo.dir, bad, { mode: 'ff' })).rejects.toThrow()
      await expect(rebaseOnto(repo.dir, bad)).rejects.toThrow()
    }
    repo.git(['switch', '-q', '--detach', 'HEAD'])
    await expect(rebaseOnto(repo.dir, 'refs/heads/main')).rejects.toThrow(/Check out a branch/)
  })
})

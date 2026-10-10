import { afterEach, describe, expect, it } from 'vitest'
import { getReflog, parseReflog, splitReflogSubject } from '@git-core/reflog'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

describe('splitReflogSubject / parseReflog', () => {
  it('splits action and message', () => {
    expect(splitReflogSubject('checkout: moving from main to x')).toEqual({ action: 'checkout', message: 'moving from main to x' })
    expect(splitReflogSubject('commit (amend): fix: typo')).toEqual({ action: 'commit (amend)', message: 'fix: typo' })
    expect(splitReflogSubject('weird')).toEqual({ action: 'weird', message: '' })
  })

  it('parses NUL-separated records and numbers selectors by position', () => {
    const out = 'aaaa\0HEAD@{1700000100}\0commit: two\0bbbb\0HEAD@{1700000000}\0commit (initial): one\0'
    expect(parseReflog(out, 'HEAD')).toEqual([
      { sha: 'aaaa', selector: 'HEAD@{0}', action: 'commit', message: 'two', time: 1700000100 },
      { sha: 'bbbb', selector: 'HEAD@{1}', action: 'commit (initial)', message: 'one', time: 1700000000 },
    ])
  })
})

describe('getReflog', () => {
  it('returns [] for an empty repository and for a branch without reflog', async () => {
    const empty = createFixtureRepo()
    expect(await getReflog(empty.dir)).toEqual([])
    expect(await getReflog(empty.dir, 'refs/heads/main')).toEqual([])
    const bare = createFixtureRepo({ bare: true })
    expect(await getReflog(bare.dir)).toEqual([])
  })

  it('lists HEAD movements newest first', async () => {
    const repo = createFixtureRepo()
    const a = repo.commit('first', { 'f.txt': '1\n' })
    const b = repo.commit('second', { 'f.txt': '2\n' })
    repo.git(['switch', '-q', '-c', 'topic'])
    repo.git(['reset', '-q', '--hard', a])

    const log = await getReflog(repo.dir)
    expect(log.map((e) => [e.selector, e.sha, e.action])).toEqual([
      ['HEAD@{0}', a, 'reset'],
      ['HEAD@{1}', b, 'checkout'],
      ['HEAD@{2}', b, 'commit'],
      ['HEAD@{3}', a, 'commit (initial)'],
    ])
    expect(log[1]?.message).toBe('moving from main to topic')
    expect(log[2]?.message).toBe('second')
    // Fixture commits use a fake clock; the reflog records the (fixture) committer time.
    expect(log[3]?.time).toBeGreaterThan(1_700_000_000)
    for (const e of log) expect(repo.rev(e.selector)).toBe(e.sha)
  })

  it('shows a branch reflog and honours the limit', async () => {
    const repo = createFixtureRepo()
    repo.commit('one')
    repo.commit('two')
    const three = repo.commit('three')
    const log = await getReflog(repo.dir, 'refs/heads/main', 2)
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ selector: 'refs/heads/main@{0}', sha: three, action: 'commit', message: 'three' })
    expect(await getReflog(repo.dir, 'refs/heads/missing')).toEqual([])
  })

  it('validates ref and limit', async () => {
    const repo = createFixtureRepo()
    repo.commit('one')
    for (const ref of ['--all', 'main', 'refs/tags/v1', 'refs/heads/-x', 'refs/heads/a..b', 'refs/remotes/origin/main', 'HEAD~1']) {
      await expect(getReflog(repo.dir, ref)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    for (const limit of [0, -1, 1.5, 100_001]) {
      await expect(getReflog(repo.dir, 'HEAD', limit)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  })
})

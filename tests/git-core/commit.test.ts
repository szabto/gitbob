import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createCommit, getLastCommitMessage } from '@git-core/commit'
import { GitError } from '@git-core/errors'
import { cleanupFixtures, createFixtureRepo, isolateProcessGitEnv } from '../helpers/fixture'

let restoreEnv: () => void
beforeAll(() => {
  restoreEnv = isolateProcessGitEnv()
})
afterAll(() => restoreEnv())
afterEach(() => cleanupFixtures())

async function expectGitError(p: Promise<unknown>, code: string): Promise<GitError> {
  const err = await p.then(
    () => {
      throw new Error(`expected rejection with ${code}`)
    },
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).code).toBe(code)
  return err as GitError
}

describe('createCommit', () => {
  it('creates the root commit on an unborn branch and returns sha + summary', async () => {
    const repo = createFixtureRepo()
    expect(await getLastCommitMessage(repo.dir)).toBeNull()
    repo.write('a.txt', 'a\n')
    repo.git(['add', 'a.txt'])
    const r = await createCommit(repo.dir, 'First commit\n\nWith a body.\n', { amend: false })
    expect(r).toEqual({ sha: repo.head(), summary: 'First commit' })
    expect(repo.git(['rev-list', '--count', 'HEAD'])).toBe('1')
    expect(await getLastCommitMessage(repo.dir)).toBe('First commit\n\nWith a body.')
  })

  it('stores messages with leading dashes, shell metacharacters and unicode verbatim', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    const message = '--amend; rm -rf / && echo $(whoami) `id` | cat > x "q" \'s\' \\n *\n\n#not a comment ünïcødé 🚀 中文'
    repo.write('a.txt', 'a\n')
    repo.git(['add', 'a.txt'])
    const r = await createCommit(repo.dir, message, { amend: false })
    expect(r.summary).toBe('--amend; rm -rf / && echo $(whoami) `id` | cat > x "q" \'s\' \\n *')
    expect(await getLastCommitMessage(repo.dir)).toBe(message)
    expect(repo.git(['log', '-1', '--format=%B'])).toBe(message)
  })

  it('amends: new sha, same parent, includes newly staged changes', async () => {
    const repo = createFixtureRepo()
    const parent = repo.commit('parent')
    repo.write('a.txt', 'a\n')
    repo.git(['add', 'a.txt'])
    const first = await createCommit(repo.dir, 'original', { amend: false })
    repo.write('b.txt', 'b\n')
    repo.git(['add', 'b.txt'])
    const amended = await createCommit(repo.dir, 'amended', { amend: true })
    expect(amended.sha).not.toBe(first.sha)
    expect(amended.summary).toBe('amended')
    expect(repo.rev('HEAD^')).toBe(parent)
    expect(repo.git(['show', '--name-only', '--format=', 'HEAD']).split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('amends the message only when nothing is staged', async () => {
    const repo = createFixtureRepo()
    const parent = repo.commit('parent')
    const sha = repo.commit('tpyo', { 'a.txt': 'a\n' })
    const tree = repo.rev('HEAD^{tree}')
    const r = await createCommit(repo.dir, 'typo fixed', { amend: true })
    expect(r.sha).not.toBe(sha)
    expect(r.summary).toBe('typo fixed')
    expect(repo.rev('HEAD^{tree}')).toBe(tree)
    expect(repo.rev('HEAD^')).toBe(parent)
  })

  it('fails with git output when nothing is staged', async () => {
    const repo = createFixtureRepo()
    const head = repo.commit('init', { 'a.txt': 'a\n' })
    repo.write('a.txt', 'unstaged\n')
    const err = await expectGitError(createCommit(repo.dir, 'nothing', { amend: false }), 'GIT_FAILED')
    expect(err.detail).toMatch(/no changes added to commit|nothing to commit/)
    expect(repo.head()).toBe(head)
  })

  it('rejects an empty message without running git', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    await expectGitError(createCommit(repo.dir, '  \n\n', { amend: false }), 'INVALID_ARGUMENT')
  })

  it.skipIf(process.platform === 'win32')('surfaces a failing pre-commit hook', async () => {
    const repo = createFixtureRepo()
    const head = repo.commit('init')
    const hook = join(repo.dir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "lint failed: bad stuff" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    repo.write('a.txt', 'a\n')
    repo.git(['add', 'a.txt'])
    const err = await expectGitError(createCommit(repo.dir, 'blocked', { amend: false }), 'GIT_FAILED')
    expect(err.detail).toContain('lint failed: bad stuff')
    expect(repo.head()).toBe(head)
  })
})

describe('getLastCommitMessage', () => {
  it('returns the raw message without trailing whitespace', async () => {
    const repo = createFixtureRepo()
    repo.commit('subject line\n\nbody line 1\nbody line 2\n\n\n')
    expect(await getLastCommitMessage(repo.dir)).toBe('subject line\n\nbody line 1\nbody line 2')
  })
})

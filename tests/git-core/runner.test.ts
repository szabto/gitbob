import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { GitError } from '@git-core/errors'
import { getGitBinary, runGit, setGitBinary } from '@git-core/runner'
import { getCommitPage } from '@git-core/log'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

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

/** Isolated identity/config for commits made directly through runGit. */
function isolatedEnv(): Record<string, string> {
  const home = makeTempDir('gitbob-runner-home-')
  return {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Runner',
    GIT_AUTHOR_EMAIL: 'runner@example.com',
    GIT_COMMITTER_NAME: 'Runner',
    GIT_COMMITTER_EMAIL: 'runner@example.com',
  }
}

/** Write an executable shell script standing in for the git binary. */
function fakeGit(body: string): string {
  const dir = makeTempDir('gitbob-fakegit-')
  const file = join(dir, 'fake-git')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

const posixOnly = process.platform === 'win32' ? it.skip : it

afterEach(() => {
  setGitBinary('git')
})
afterAll(() => {
  cleanupFixtures()
})

describe('runGit', () => {
  it('runs git and returns stdout/stderr/exitCode', async () => {
    const repo = createFixtureRepo()
    const sha = repo.commit('first')
    const res = await runGit(['rev-parse', 'HEAD'], { cwd: repo.dir })
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe(sha)
  })

  it('passes stdin input', async () => {
    const repo = createFixtureRepo()
    const res = await runGit(['hash-object', '--stdin'], { cwd: repo.dir, input: 'hello\n' })
    // Known blob id of "hello\n".
    expect(res.stdout.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('rejects non-zero exit with GIT_FAILED, stderr detail and exitCode', async () => {
    const repo = createFixtureRepo()
    const err = await expectGitError(runGit(['rev-parse', '--verify', 'does-not-exist'], { cwd: repo.dir }), 'GIT_FAILED')
    expect(err.exitCode).toBe(128)
    expect(err.detail).toMatch(/fatal/)
    expect(err.message).not.toMatch(/^fatal: /)
  })

  it('treats okExitCodes as success', async () => {
    const repo = createFixtureRepo()
    const res = await runGit(['rev-parse', '-q', '--verify', 'nope'], { cwd: repo.dir, okExitCodes: [0, 1] })
    expect(res.exitCode).toBe(1)
    expect(res.stdout).toBe('')
  })

  posixOnly('times out a hung process with TIMEOUT', async () => {
    const dir = makeTempDir()
    setGitBinary(fakeGit('exec sleep 10'))
    const start = Date.now()
    await expectGitError(runGit(['status'], { cwd: dir, timeoutMs: 200 }), 'TIMEOUT')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  posixOnly('times out even when a grandchild keeps the output pipes open', async () => {
    const dir = makeTempDir()
    // The shell is killed but `sleep` (a grandchild) inherits stdout/stderr.
    setGitBinary(fakeGit('sleep 10\necho done'))
    const start = Date.now()
    await expectGitError(runGit(['status'], { cwd: dir, timeoutMs: 200 }), 'TIMEOUT')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  posixOnly('cancels via AbortSignal with CANCELLED', async () => {
    const dir = makeTempDir()
    setGitBinary(fakeGit('exec sleep 10'))
    const ac = new AbortController()
    const p = runGit(['status'], { cwd: dir, signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    const start = Date.now()
    await expectGitError(p, 'CANCELLED')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const dir = makeTempDir()
    const ac = new AbortController()
    ac.abort()
    await expectGitError(runGit(['version'], { cwd: dir, signal: ac.signal }), 'CANCELLED')
  })

  it('fails when output exceeds maxOutputBytes', async () => {
    const repo = createFixtureRepo()
    repo.commit('one', { 'a.txt': 'x'.repeat(10_000) })
    const err = await expectGitError(
      runGit(['cat-file', '-p', 'HEAD:a.txt'], { cwd: repo.dir, maxOutputBytes: 100 }),
      'GIT_FAILED',
    )
    expect(err.message).toMatch(/more than 100 bytes/)
  })

  it('reports a missing binary as GIT_NOT_FOUND', async () => {
    const dir = makeTempDir()
    setGitBinary(join(dir, 'no-such-git-binary'))
    expect(getGitBinary()).toBe(join(dir, 'no-such-git-binary'))
    await expectGitError(runGit(['version'], { cwd: dir }), 'GIT_NOT_FOUND')
    setGitBinary('git')
    const res = await runGit(['version'], { cwd: dir })
    expect(res.stdout).toMatch(/^git version/)
  })

  it('rejects arguments containing NUL with INVALID_ARGUMENT', async () => {
    const dir = makeTempDir()
    await expectGitError(runGit(['log', 'a\0b'], { cwd: dir }), 'INVALID_ARGUMENT')
  })

  it('passes shell metacharacters literally', async () => {
    const repo = createFixtureRepo()
    const env = isolatedEnv()
    const messages = ['$(touch PWNED)', '; touch PWNED2', '`touch PWNED3` && echo "x" | cat > PWNED4']
    for (const m of messages) {
      await runGit(['commit', '--allow-empty', '-q', '-m', m], { cwd: repo.dir, env })
    }
    for (const f of ['PWNED', 'PWNED2', 'PWNED3', 'PWNED4']) {
      expect(existsSync(join(repo.dir, f))).toBe(false)
      expect(existsSync(join(process.cwd(), f))).toBe(false)
    }
    const { commits } = await getCommitPage(repo.dir, { skip: 0, limit: 10 })
    expect(commits.map((c) => c.subject)).toEqual([...messages].reverse())
  })

  it('ignores color.ui=always from repository config', async () => {
    const repo = createFixtureRepo()
    repo.git(['config', 'color.ui', 'always'])
    repo.git(['config', 'color.diff', 'always'])
    repo.git(['config', 'log.decorate', 'full'])
    repo.commit('colorful', { 'a.txt': 'a\n' })
    const { commits } = await getCommitPage(repo.dir, { skip: 0, limit: 10 })
    expect(commits).toHaveLength(1)
    const c = commits[0]!
    expect(JSON.stringify(c)).not.toContain('\u001b')
    expect(c.subject).toBe('colorful')
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

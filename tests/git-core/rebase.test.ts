import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getRebaseTodo, interactiveRebase, type RebaseTodoItem } from '@git-core/rebase'
import { abortOperation, continueOperation } from '@git-core/history'
import { getOperation, runStatus } from '@git-core/status'
import { cleanupFixtures, createFixtureRepo, makeTempDir, type FixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

const subjects = (repo: FixtureRepo, range: string): string[] =>
  repo.git(['log', '--reverse', '--format=%s', range]).split('\n').filter(Boolean)
const body = (repo: FixtureRepo, rev = 'HEAD'): string => repo.git(['log', '-1', '--format=%B', rev])
const read = (repo: FixtureRepo, p: string): string => readFileSync(join(repo.dir, p), 'utf8')

function linear(prefix?: string) {
  const repo = createFixtureRepo(prefix ? { prefix } : {})
  const base = repo.commit('base', { 'base.txt': 'base\n' })
  const a = repo.commit('A', { 'a.txt': 'a\n' })
  const b = repo.commit('B', { 'b.txt': 'b\n' })
  const c = repo.commit('C', { 'c.txt': 'c\n' })
  return { repo, base, a, b, c }
}

const plan = (...items: [string, RebaseTodoItem['action'], string?][]): RebaseTodoItem[] =>
  items.map(([sha, action, message]) => ({ sha, action, ...(message !== undefined ? { message } : {}) }))

describe('getRebaseTodo', () => {
  it('lists base..HEAD oldest first', async () => {
    const { repo, base, a, b, c } = linear()
    const todo = await getRebaseTodo(repo.dir, base)
    expect(todo.map((t) => t.sha)).toEqual([a, b, c])
    expect(todo[0]).toMatchObject({ subject: 'A', authorName: 'Test Author' })
    expect(todo[0]!.time).toBeGreaterThan(1_700_000_000)
    expect(await getRebaseTodo(repo.dir, c)).toEqual([])
  })

  it('rejects merge commits, non-ancestors, detached HEAD and bad input', async () => {
    const { repo, base, a } = linear()
    repo.branch('side', base)
    repo.checkout('side')
    const side = repo.commit('side', { 's.txt': 's\n' })
    repo.checkout('main')
    repo.merge('side')
    await expect(getRebaseTodo(repo.dir, base)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Interactive rebase of merge commits is not supported',
    })
    // The merge commit itself is in side..HEAD as well.
    await expect(getRebaseTodo(repo.dir, side)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    repo.checkout('side')
    await expect(getRebaseTodo(repo.dir, a)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/not an ancestor/) })
    repo.git(['checkout', '-q', '--detach', 'HEAD'])
    await expect(getRebaseTodo(repo.dir, base)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/detached/) })
    await expect(getRebaseTodo(repo.dir, 'HEAD~1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(getRebaseTodo(repo.dir, '--exec=x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('rejects an unborn branch', async () => {
    const repo = createFixtureRepo()
    await expect(getRebaseTodo(repo.dir, 'abcd')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('interactiveRebase', () => {
  it('reorders commits', async () => {
    const { repo, base, a, b, c } = linear()
    expect(await interactiveRebase(repo.dir, base, plan([c, 'pick'], [a, 'pick'], [b, 'pick']))).toEqual({ completed: true })
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['C', 'A', 'B'])
    expect(repo.git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main')
    expect(await getOperation(repo.dir)).toBeNull()
    expect(read(repo, 'a.txt') + read(repo, 'b.txt') + read(repo, 'c.txt')).toBe('a\nb\nc\n')
  })

  it('drops commits', async () => {
    const { repo, base, a, b, c } = linear()
    await interactiveRebase(repo.dir, base, plan([a, 'pick'], [b, 'drop'], [c, 'pick']))
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['A', 'C'])
    expect(existsSync(join(repo.dir, 'b.txt'))).toBe(false)
  })

  it('drops every commit', async () => {
    const { repo, base, a, b, c } = linear()
    expect(await interactiveRebase(repo.dir, base, plan([a, 'drop'], [b, 'drop'], [c, 'drop']))).toEqual({ completed: true })
    expect(repo.head()).toBe(base)
  })

  it('squashes with git’s default combined message', async () => {
    const { repo, base, a, b, c } = linear()
    await interactiveRebase(repo.dir, base, plan([a, 'pick'], [b, 'squash'], [c, 'pick']))
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['A', 'C'])
    const msg = body(repo, 'HEAD~1')
    expect(msg).toContain('A')
    expect(msg).toContain('B')
    expect(msg).not.toMatch(/^#/m)
    expect(repo.git(['show', '--format=', '--name-only', 'HEAD~1']).split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('squashes with a custom final message for the whole chain', async () => {
    const { repo, base, a, b, c } = linear()
    await interactiveRebase(repo.dir, base, plan([a, 'pick'], [b, 'squash', 'Combined "AB"'], [c, 'fixup']))
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['Combined "AB"'])
    expect(body(repo)).toBe('Combined "AB"')
    expect(repo.git(['show', '--format=', '--name-only', 'HEAD']).split('\n').sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('fixes up keeping the first message', async () => {
    const { repo, base, a, b, c } = linear()
    await interactiveRebase(repo.dir, base, plan([a, 'pick'], [b, 'pick'], [c, 'fixup']))
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['A', 'B'])
    expect(body(repo)).toBe('B')
  })

  it('rewords with shell metacharacters stored verbatim and never executed', async () => {
    const { repo, base, a, b, c } = linear()
    const marker = join(repo.dir, 'pwned')
    const message = `Subject with 'single' and "double" quotes\n\n$(touch ${marker}) \`touch ${marker}\` ; rm -rf / #\nexec touch ${marker}\n%s %n`
    await interactiveRebase(repo.dir, base, plan([a, 'reword', message], [b, 'pick'], [c, 'pick']))
    expect(body(repo, 'HEAD~2')).toBe(message)
    expect(subjects(repo, `${base}..HEAD`)).toEqual([`Subject with 'single' and "double" quotes`, 'B', 'C'])
    expect(existsSync(marker)).toBe(false)
    // Author is preserved; temp message files are cleaned up after completion.
    expect(repo.git(['log', '-1', '--format=%an', 'HEAD~2'])).toBe('Test Author')
    expect(existsSync(join(repo.dir, '.git', 'gitbob-rebase'))).toBe(false)
  })

  it('works when the repository path contains spaces and quotes', async () => {
    const { repo, base, a, b, c } = linear("gitbob repo with spaces 'q' ")
    expect(repo.dir).toContain(' ')
    await interactiveRebase(repo.dir, base, plan([c, 'pick'], [b, 'reword', 'B2'], [a, 'pick']))
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['C', 'B2', 'A'])
  })

  it('works when the temp directory path contains spaces and quotes', async () => {
    const { repo, base, a, b, c } = linear()
    const tmp = makeTempDir("gitbob tmp 'x' $(y) ")
    const saved = process.env.TMPDIR
    process.env.TMPDIR = tmp
    try {
      expect(tmpdir()).toBe(tmp)
      await interactiveRebase(repo.dir, base, plan([b, 'pick'], [a, 'pick'], [c, 'reword', 'C2']))
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
    }
    expect(subjects(repo, `${base}..HEAD`)).toEqual(['B', 'A', 'C2'])
    expect(readdirSync(tmp)).toEqual([])
  })

  describe('conflicts', () => {
    function conflicting() {
      const repo = createFixtureRepo()
      const base = repo.commit('base', { 'f.txt': '0\n' })
      const a = repo.commit('A', { 'f.txt': '1\n' })
      const b = repo.commit('B', { 'f.txt': '2\n' })
      return { repo, base, a, b }
    }

    it('stops and leaves the rebase in progress; abort restores HEAD exactly', async () => {
      const { repo, base, a, b } = conflicting()
      const before = repo.head()
      expect(await interactiveRebase(repo.dir, base, plan([b, 'pick'], [a, 'reword', 'A reworded']))).toEqual({
        completed: false,
      })
      expect(await getOperation(repo.dir)).toBe('rebase')
      expect((await runStatus(repo.dir)).entries.some((e) => e.kind === 'unmerged')).toBe(true)
      await abortOperation(repo.dir)
      expect(repo.head()).toBe(before)
      expect(repo.git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main')
      expect(await getOperation(repo.dir)).toBeNull()
      expect(read(repo, 'f.txt')).toBe('2\n')
    })

    it('continues after resolving, running the pending reword', async () => {
      const { repo, base, a, b } = conflicting()
      expect((await interactiveRebase(repo.dir, base, plan([b, 'pick'], [a, 'reword', 'A $(reworded)']))).completed).toBe(false)
      // Stopped at B (applied onto base): resolve and continue.
      repo.write('f.txt', '2\n')
      repo.git(['add', 'f.txt'])
      let stopped = false
      try {
        await continueOperation(repo.dir)
      } catch {
        stopped = true // A now conflicts too
      }
      expect(stopped).toBe(true)
      expect(await getOperation(repo.dir)).toBe('rebase')
      repo.write('f.txt', '1\n')
      repo.git(['add', 'f.txt'])
      await continueOperation(repo.dir)
      expect(await getOperation(repo.dir)).toBeNull()
      expect(subjects(repo, `${base}..HEAD`)).toEqual(['B', 'A $(reworded)'])
      expect(read(repo, 'f.txt')).toBe('1\n')
    })
  })

  describe('validation', () => {
    it('rejects plans that are not a permutation of the range', async () => {
      const { repo, base, a, b, c } = linear()
      const head = repo.head()
      await expect(interactiveRebase(repo.dir, base, plan([a, 'pick'], [b, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(interactiveRebase(repo.dir, base, plan([a, 'pick'], [a, 'pick'], [c, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(interactiveRebase(repo.dir, base, plan([a, 'pick'], [b, 'pick'], [c, 'pick'], [base, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(interactiveRebase(repo.dir, base, plan([a.slice(0, 10), 'pick'], [b, 'pick'], [c, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(interactiveRebase(repo.dir, base, [])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(
        interactiveRebase(repo.dir, base, [{ sha: a, action: 'exec' as never }, { sha: b, action: 'pick' }, { sha: c, action: 'pick' }]),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(repo.head()).toBe(head)
    })

    it('rejects squash/fixup first, reword without message and stray messages', async () => {
      const { repo, base, a, b, c } = linear()
      await expect(interactiveRebase(repo.dir, base, plan([a, 'squash'], [b, 'pick'], [c, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(interactiveRebase(repo.dir, base, plan([a, 'drop'], [b, 'fixup'], [c, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(interactiveRebase(repo.dir, base, plan([a, 'reword'], [b, 'pick'], [c, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(interactiveRebase(repo.dir, base, plan([a, 'reword', '  \n'], [b, 'pick'], [c, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(interactiveRebase(repo.dir, base, plan([a, 'pick', 'x'], [b, 'pick'], [c, 'pick']))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })

    it('refuses with uncommitted tracked changes but allows untracked files', async () => {
      const { repo, base, a, b, c } = linear()
      repo.write('a.txt', 'dirty\n')
      await expect(interactiveRebase(repo.dir, base, plan([c, 'pick'], [b, 'pick'], [a, 'pick']))).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringMatching(/Commit or stash/),
      })
      expect(read(repo, 'a.txt')).toBe('dirty\n')
      repo.git(['checkout', '--', 'a.txt'])
      repo.write('untracked.txt', 'mine\n')
      await interactiveRebase(repo.dir, base, plan([c, 'pick'], [b, 'pick'], [a, 'pick']))
      expect(read(repo, 'untracked.txt')).toBe('mine\n')
    })

    it('refuses while another operation is in progress', async () => {
      const { repo, base, a, b } = (() => {
        const r = createFixtureRepo()
        const base = r.commit('base', { 'f.txt': '0\n' })
        const a = r.commit('A', { 'f.txt': '1\n' })
        const b = r.commit('B', { 'f.txt': '2\n' })
        return { repo: r, base, a, b }
      })()
      expect((await interactiveRebase(repo.dir, base, plan([b, 'pick'], [a, 'pick']))).completed).toBe(false)
      await expect(interactiveRebase(repo.dir, base, plan([a, 'pick'], [b, 'pick']))).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringMatching(/in progress/),
      })
      // Message dir survives a stopped rebase (exec lines may still need it)
      expect(readdirSync(join(repo.dir, '.git'))).toContain('rebase-merge')
      await abortOperation(repo.dir)
    })
  })
})

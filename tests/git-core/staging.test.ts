import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GitError } from '@git-core/errors'
import { discardPaths, stageAll, stagePaths, unstageAll, unstagePaths } from '@git-core/staging'
import { getStatus } from '@git-core/status'
import type { StatusEntry } from '@shared/types'
import {
  cleanupFixtures,
  createFixtureRepo,
  isolateProcessGitEnv,
  makeMergeConflict,
  makeTempDir,
  type FixtureRepo,
} from '../helpers/fixture'

let restoreEnv: () => void
beforeAll(() => {
  restoreEnv = isolateProcessGitEnv()
})
afterAll(() => restoreEnv())
afterEach(() => cleanupFixtures())

async function entries(repo: FixtureRepo): Promise<StatusEntry[]> {
  return (await getStatus(repo.dir)).entries
}
async function entry(repo: FixtureRepo, path: string): Promise<StatusEntry | undefined> {
  return (await entries(repo)).find((e) => e.path === path)
}

/** Trash callback that moves files into a temp "trash" directory and records the calls. */
function makeTrash(): { calls: string[]; dir: string; trash: (p: string) => Promise<void> } {
  const dir = makeTempDir('gitbob-trash-')
  const calls: string[] = []
  let n = 0
  return {
    calls,
    dir,
    trash: async (p: string) => {
      calls.push(p)
      renameSync(p, join(dir, `${n++}-${basename(p)}`))
    },
  }
}

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

// '*' is not allowed in Windows file names.
const SPECIAL = process.platform === 'win32' ? 'sp ace [x].txt' : 'sp ace [x]*.txt'

describe('stage / unstage', () => {
  it('round-trips modifications, additions and deletions', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n', 'gone.txt': 'g\n', [SPECIAL]: 's\n' })
    repo.write('a.txt', 'changed\n')
    repo.write('new dir/n é.txt', 'n\n')
    repo.write(SPECIAL, 'changed\n')
    rmSync(join(repo.dir, 'gone.txt'))

    await stagePaths(repo.dir, ['a.txt', 'gone.txt', 'new dir/n é.txt', SPECIAL])
    expect(await entry(repo, 'a.txt')).toMatchObject({ index: 'M', worktree: '.' })
    expect(await entry(repo, 'gone.txt')).toMatchObject({ index: 'D', worktree: '.' })
    expect(await entry(repo, 'new dir/n é.txt')).toMatchObject({ index: 'A', worktree: '.' })
    expect(await entry(repo, SPECIAL)).toMatchObject({ index: 'M' })

    await unstagePaths(repo.dir, ['a.txt', 'gone.txt', 'new dir/n é.txt', SPECIAL])
    expect(await entry(repo, 'a.txt')).toMatchObject({ index: '.', worktree: 'M' })
    expect(await entry(repo, 'gone.txt')).toMatchObject({ index: '.', worktree: 'D' })
    expect(await entry(repo, 'new dir/n é.txt')).toMatchObject({ kind: 'untracked' })
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('changed\n')
  })

  // Windows file names cannot contain these characters (" * : tab).

  it.skipIf(process.platform === 'win32')('treats pathspecs literally (a glob-like name does not match other files)', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n' })
    repo.write('*.txt', 'star\n')
    repo.write('a.txt', 'changed\n')
    await stagePaths(repo.dir, ['*.txt'])
    expect(await entry(repo, '*.txt')).toMatchObject({ index: 'A' })
    expect(await entry(repo, 'a.txt')).toMatchObject({ index: '.', worktree: 'M' })
  })

  it('stageAll / unstageAll', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n' })
    repo.write('a.txt', 'b\n')
    repo.write('u.txt', 'u\n')
    await stageAll(repo.dir)
    expect((await entries(repo)).map((e) => [e.path, e.index, e.worktree])).toEqual([
      ['a.txt', 'M', '.'],
      ['u.txt', 'A', '.'],
    ])
    await unstageAll(repo.dir)
    expect((await entries(repo)).map((e) => [e.path, e.index, e.worktree])).toEqual([
      ['a.txt', '.', 'M'],
      ['u.txt', '?', '?'],
    ])
  })

  it('works on an unborn branch', async () => {
    const repo = createFixtureRepo()
    repo.write('a.txt', 'a\n')
    repo.write('d/b.txt', 'b\n')
    await stagePaths(repo.dir, ['a.txt'])
    expect(await entry(repo, 'a.txt')).toMatchObject({ index: 'A' })
    // Staged content differing from the worktree must not block unstaging.
    repo.write('a.txt', 'a2\n')
    await unstagePaths(repo.dir, ['a.txt', 'not-there.txt'])
    expect(await entry(repo, 'a.txt')).toMatchObject({ kind: 'untracked' })
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('a2\n')

    await stageAll(repo.dir)
    expect((await entries(repo)).every((e) => e.index === 'A')).toBe(true)
    await unstageAll(repo.dir)
    expect((await entries(repo)).every((e) => e.kind === 'untracked')).toBe(true)
    expect(existsSync(join(repo.dir, 'd/b.txt'))).toBe(true)
  })

  it('unstages both sides of a staged rename', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'old.txt': 'line one\nline two\nline three\n' })
    repo.git(['mv', 'old.txt', 'new.txt'])
    expect(await entry(repo, 'new.txt')).toMatchObject({ kind: 'renamed', origPath: 'old.txt' })

    await unstagePaths(repo.dir, ['new.txt'])
    const e = await entries(repo)
    expect(e.find((x) => x.path === 'old.txt')).toMatchObject({ index: '.', worktree: 'D' })
    expect(e.find((x) => x.path === 'new.txt')).toMatchObject({ kind: 'untracked' })
    expect(e.some((x) => x.index !== '.' && x.index !== '?')).toBe(false)
  })

  it('marks a conflict resolved', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    repo.write(path, 'resolved\n')
    await stagePaths(repo.dir, [path])
    expect(await entry(repo, path)).toMatchObject({ kind: 'ordinary', index: 'M', worktree: '.' })
  })

  it('stages a long path list via stdin', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    const paths: string[] = []
    for (let i = 0; i < 3000; i++) {
      const p = `many/a-rather-long-directory-name-to-inflate-argv/file-number-${i}.txt`
      paths.push(p)
      repo.write(p, `${i}\n`)
    }
    await stagePaths(repo.dir, paths)
    const e = await entries(repo)
    expect(e.filter((x) => x.index === 'A')).toHaveLength(3000)
  })

  it('rejects paths outside the repository', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n' })
    await expectGitError(stagePaths(repo.dir, ['../x']), 'INVALID_ARGUMENT')
    await expectGitError(unstagePaths(repo.dir, ['/etc/passwd']), 'INVALID_ARGUMENT')
  })
})

describe('discardPaths', () => {
  it('restores modified and deleted tracked files from the index', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n', 'del.txt': 'd\n', 'keep.txt': 'k\n' })
    repo.write('a.txt', 'changed\n')
    repo.write('keep.txt', 'keep me\n')
    rmSync(join(repo.dir, 'del.txt'))
    const t = makeTrash()

    await discardPaths(repo.dir, ['a.txt', 'del.txt'], t)
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(repo.dir, 'del.txt'), 'utf8')).toBe('d\n')
    expect(readFileSync(join(repo.dir, 'keep.txt'), 'utf8')).toBe('keep me\n')
    expect(t.calls).toEqual([])
  })

  it('keeps staged content and only discards the worktree part', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'v1\n' })
    repo.write('a.txt', 'v2 staged\n')
    repo.git(['add', 'a.txt'])
    repo.write('a.txt', 'v3 worktree\n')

    await discardPaths(repo.dir, ['a.txt'], makeTrash())
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('v2 staged\n')
    expect(await entry(repo, 'a.txt')).toMatchObject({ index: 'M', worktree: '.' })
  })

  it('restores a staged new file deleted from the worktree on an unborn branch', async () => {
    const repo = createFixtureRepo()
    repo.write('a.txt', 'staged\n')
    repo.git(['add', 'a.txt'])
    rmSync(join(repo.dir, 'a.txt'))
    await discardPaths(repo.dir, ['a.txt'], makeTrash())
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('staged\n')
  })

  it('hands untracked files to the trash callback instead of deleting them', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n' })
    repo.write('dir/new é.txt', 'precious\n')
    repo.write('dir/other.txt', 'other\n')
    const t = makeTrash()

    await discardPaths(repo.dir, ['dir/new é.txt'], t)
    expect(t.calls).toEqual([join(repo.dir, 'dir/new é.txt')])
    expect(existsSync(join(repo.dir, 'dir/new é.txt'))).toBe(false)
    expect(readFileSync(join(t.dir, '0-new é.txt'), 'utf8')).toBe('precious\n')
    expect(existsSync(join(repo.dir, 'dir/other.txt'))).toBe(true)
  })

  it('does not delete untracked files itself when the callback leaves them', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    repo.write('u.txt', 'u\n')
    const calls: string[] = []
    await discardPaths(repo.dir, ['u.txt'], {
      trash: async (p) => {
        calls.push(p)
      },
    })
    expect(calls).toEqual([join(repo.dir, 'u.txt')])
    expect(readFileSync(join(repo.dir, 'u.txt'), 'utf8')).toBe('u\n')
  })

  it('is a no-op for unchanged, ignored and missing paths', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n', '.gitignore': '*.log\n' })
    repo.write('x.log', 'ignored\n')
    const t = makeTrash()
    await discardPaths(repo.dir, ['a.txt', 'x.log', 'missing.txt'], t)
    expect(t.calls).toEqual([])
    expect(existsSync(join(repo.dir, 'x.log'))).toBe(true)
  })

  it('rejects path traversal before touching anything', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n' })
    repo.write('a.txt', 'changed\n')
    repo.write('u.txt', 'u\n')
    const t = makeTrash()
    for (const bad of ['../outside.txt', 'dir/../../x', '/etc/hosts', '', 'a\0b']) {
      await expectGitError(discardPaths(repo.dir, ['a.txt', 'u.txt', bad], t), 'INVALID_ARGUMENT')
    }
    expect(t.calls).toEqual([])
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('changed\n')
    expect(existsSync(join(repo.dir, 'u.txt'))).toBe(true)
  })

  it('refuses to discard a conflicted file', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const before = readFileSync(join(repo.dir, path), 'utf8')
    await expectGitError(discardPaths(repo.dir, [path], makeTrash()), 'INVALID_ARGUMENT')
    expect(readFileSync(join(repo.dir, path), 'utf8')).toBe(before)
  })
})

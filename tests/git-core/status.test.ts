import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getStatus, parseStatusV2 } from '@git-core/status'
import type { StatusEntry } from '@shared/types'
import {
  cleanupFixtures,
  cloneFixtureRepo,
  createFixtureRepo,
  isolateProcessGitEnv,
  makeMergeConflict,
} from '../helpers/fixture'

let restoreEnv: () => void
beforeAll(() => {
  restoreEnv = isolateProcessGitEnv()
})
afterAll(() => restoreEnv())
afterEach(() => cleanupFixtures())

const find = (entries: StatusEntry[], path: string): StatusEntry | undefined => entries.find((e) => e.path === path)

describe('parseStatusV2', () => {
  it('parses headers and every entry kind', () => {
    const out = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +3 -2',
      '1 .M N... 100644 100644 100644 aaaa bbbb file with spaces.txt',
      '1 A. S.M. 160000 160000 160000 aaaa bbbb sub',
      '2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 c onflict.txt',
      '? dir/untracked é.txt',
      '! ignored.log',
      '',
    ].join('\0')
    const { branch, entries } = parseStatusV2(out)
    expect(branch).toEqual({
      oid: '1234567890abcdef1234567890abcdef12345678',
      head: 'feature/x',
      upstream: 'origin/feature/x',
      ahead: 3,
      behind: 2,
    })
    expect(entries).toEqual([
      { path: 'file with spaces.txt', index: '.', worktree: 'M', kind: 'ordinary', submodule: false },
      { path: 'sub', index: 'A', worktree: '.', kind: 'ordinary', submodule: true },
      {
        path: 'new name.txt',
        origPath: 'old name.txt',
        index: 'R',
        worktree: '.',
        kind: 'renamed',
        submodule: false,
      },
      { path: 'c onflict.txt', index: 'U', worktree: 'U', kind: 'unmerged', submodule: false },
      { path: 'dir/untracked é.txt', index: '?', worktree: '?', kind: 'untracked', submodule: false },
      { path: 'ignored.log', index: '!', worktree: '!', kind: 'ignored', submodule: false },
    ])
  })

  it('handles initial and detached headers', () => {
    const { branch, entries } = parseStatusV2('# branch.oid (initial)\0# branch.head (detached)\0')
    expect(branch).toEqual({ oid: null, head: null, upstream: null, ahead: 0, behind: 0 })
    expect(entries).toEqual([])
    expect(parseStatusV2('').entries).toEqual([])
  })
})

describe('getStatus', () => {
  it('reports every working tree state from a real repository', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', {
      'modified.txt': 'a\n',
      'both.txt': 'a\n',
      'deleted-wt.txt': 'a\n',
      'deleted-idx.txt': 'a\n',
      'rename-me.txt': 'some content that is long enough\nfor rename detection\n',
      'sp ace & ü.txt': 'a\n',
      '.gitignore': '*.log\n',
    })
    repo.write('modified.txt', 'b\n')
    repo.write('both.txt', 'staged\n')
    repo.git(['add', 'both.txt'])
    repo.write('both.txt', 'unstaged\n')
    repo.write('added.txt', 'new\n')
    repo.git(['add', 'added.txt'])
    rmSync(join(repo.dir, 'deleted-wt.txt'))
    repo.git(['rm', '-q', 'deleted-idx.txt'])
    repo.git(['mv', 'rename-me.txt', 'renamed.txt'])
    repo.write('sp ace & ü.txt', 'changed\n')
    repo.write('deep/nested/dir/u ntracked.txt', 'x\n')
    repo.write('debug.log', 'ignored\n')

    const s = await getStatus(repo.dir)
    expect(s.operation).toBeNull()
    expect(s.branch).toEqual({ oid: repo.head(), head: 'main', upstream: null, ahead: 0, behind: 0 })
    const e = s.entries
    expect(find(e, 'modified.txt')).toMatchObject({ index: '.', worktree: 'M', kind: 'ordinary' })
    expect(find(e, 'both.txt')).toMatchObject({ index: 'M', worktree: 'M', kind: 'ordinary' })
    expect(find(e, 'added.txt')).toMatchObject({ index: 'A', worktree: '.', kind: 'ordinary' })
    expect(find(e, 'deleted-wt.txt')).toMatchObject({ index: '.', worktree: 'D' })
    expect(find(e, 'deleted-idx.txt')).toMatchObject({ index: 'D', worktree: '.' })
    expect(find(e, 'renamed.txt')).toMatchObject({
      origPath: 'rename-me.txt',
      index: 'R',
      worktree: '.',
      kind: 'renamed',
    })
    expect(find(e, 'sp ace & ü.txt')).toMatchObject({ worktree: 'M' })
    expect(find(e, 'deep/nested/dir/u ntracked.txt')).toMatchObject({ kind: 'untracked', index: '?', worktree: '?' })
    expect(find(e, 'debug.log')).toBeUndefined()
    expect(e.every((x) => !x.submodule)).toBe(true)
  })

  it('detects a conflicting merge', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const s = await getStatus(repo.dir)
    expect(s.operation).toBe('merge')
    expect(find(s.entries, path)).toMatchObject({ kind: 'unmerged', index: 'U', worktree: 'U' })
  })

  it('detects an interrupted cherry-pick', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'f.txt': 'base\n' })
    repo.branch('other')
    repo.commit('ours', { 'f.txt': 'ours\n' })
    repo.checkout('other')
    const theirs = repo.commit('theirs', { 'f.txt': 'theirs\n' })
    repo.checkout('main')
    expect(() => repo.git(['cherry-pick', theirs], {})).toThrow()
    expect((await getStatus(repo.dir)).operation).toBe('cherry-pick')
    repo.git(['cherry-pick', '--abort'])
    expect((await getStatus(repo.dir)).operation).toBeNull()
  })

  it('detects an interrupted rebase', async () => {
    const repo = createFixtureRepo()
    makeMergeConflict(repo)
    repo.git(['merge', '--abort'])
    repo.checkout('other')
    expect(() => repo.git(['rebase', 'main'])).toThrow()
    expect((await getStatus(repo.dir)).operation).toBe('rebase')
  })

  it('reports ahead/behind against an upstream', async () => {
    const origin = createFixtureRepo()
    origin.commit('one', { 'a.txt': '1\n' })
    const clone = cloneFixtureRepo(origin)
    origin.commit('two', { 'a.txt': '2\n' })
    clone.git(['fetch', '-q'])
    clone.commit('local1', { 'b.txt': '1\n' })
    clone.commit('local2', { 'b.txt': '2\n' })
    const s = await getStatus(clone.dir)
    expect(s.branch).toMatchObject({ head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
  })

  it('reports detached HEAD and unborn branches', async () => {
    const repo = createFixtureRepo()
    const first = repo.commit('one')
    repo.commit('two')
    repo.git(['checkout', '-q', '--detach', first])
    expect((await getStatus(repo.dir)).branch).toEqual({ oid: first, head: null, upstream: null, ahead: 0, behind: 0 })

    const empty = createFixtureRepo({ initialBranch: 'trunk' })
    empty.write('x.txt', 'x\n')
    const s = await getStatus(empty.dir)
    expect(s.branch).toEqual({ oid: null, head: 'trunk', upstream: null, ahead: 0, behind: 0 })
    expect(s.entries).toEqual([{ path: 'x.txt', index: '?', worktree: '?', kind: 'untracked', submodule: false }])
  })

  it('flags submodule entries', async () => {
    const sub = createFixtureRepo()
    sub.commit('sub', { 's.txt': 's\n' })
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n' })
    repo.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'mod'])
    const s = await getStatus(repo.dir)
    expect(find(s.entries, 'mod')).toMatchObject({ index: 'A', submodule: true })
    expect(find(s.entries, '.gitmodules')).toMatchObject({ index: 'A', submodule: false })
  })
})

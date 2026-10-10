import { symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getFileContents } from '@git-core/contents'
import { GitError } from '@git-core/errors'
import { cleanupFixtures, createFixtureRepo, makeMergeConflict, makeTempDir } from '../helpers/fixture'

afterEach(() => cleanupFixtures())

async function expectGitError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => new Error('expected rejection'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).code).toBe(code)
}

describe('getFileContents', () => {
  it('unstaged: index vs worktree', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'one\n' })
    repo.write('a.txt', 'staged\n')
    repo.git(['add', 'a.txt'])
    repo.write('a.txt', 'worktree\r\nline\n')
    expect(await getFileContents(repo.dir, { kind: 'unstaged', path: 'a.txt' })).toEqual({
      oldText: 'staged\n',
      newText: 'worktree\r\nline\n',
      binary: false,
      tooLarge: false,
    })
  })

  it('unstaged: deleted worktree file has a null new side', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'one\n' })
    unlinkSync(join(repo.dir, 'a.txt'))
    const c = await getFileContents(repo.dir, { kind: 'unstaged', path: 'a.txt' })
    expect(c).toMatchObject({ oldText: 'one\n', newText: null })
  })

  it('staged: HEAD vs index, including additions, deletions and an unborn branch', async () => {
    const repo = createFixtureRepo()
    repo.write('new.txt', 'brand new\n')
    repo.git(['add', 'new.txt'])
    expect(await getFileContents(repo.dir, { kind: 'staged', path: 'new.txt' })).toMatchObject({
      oldText: null,
      newText: 'brand new\n',
    })

    repo.commit('init', { 'a.txt': 'one\n', 'b.txt': 'bye\n' })
    repo.write('a.txt', 'two\n')
    repo.git(['add', 'a.txt'])
    repo.git(['rm', '-q', 'b.txt'])
    expect(await getFileContents(repo.dir, { kind: 'staged', path: 'a.txt' })).toMatchObject({
      oldText: 'one\n',
      newText: 'two\n',
    })
    expect(await getFileContents(repo.dir, { kind: 'staged', path: 'b.txt' })).toMatchObject({
      oldText: 'bye\n',
      newText: null,
    })
  })

  it('staged: a rename with oldPath reads the old side from HEAD:<oldPath>', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'one\ntwo\n' })
    repo.git(['rm', '-q', 'a.txt'])
    repo.write('sub/b.txt', 'one\nTWO\n')
    repo.git(['add', 'sub/b.txt'])
    expect(await getFileContents(repo.dir, { kind: 'staged', path: 'sub/b.txt', oldPath: 'a.txt' })).toEqual({
      oldText: 'one\ntwo\n',
      newText: 'one\nTWO\n',
      binary: false,
      tooLarge: false,
    })
    // Without oldPath the renamed file has no old side, as before.
    expect(await getFileContents(repo.dir, { kind: 'staged', path: 'sub/b.txt' })).toMatchObject({
      oldText: null,
      newText: 'one\nTWO\n',
    })
    await expectGitError(
      getFileContents(repo.dir, { kind: 'staged', path: 'sub/b.txt', oldPath: '../a.txt' }),
      'INVALID_ARGUMENT',
    )
  })

  it('untracked: no old side', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'x\n' })
    repo.write('dir with space/ünï.txt', 'hello\n')
    expect(await getFileContents(repo.dir, { kind: 'untracked', path: 'dir with space/ünï.txt' })).toEqual({
      oldText: null,
      newText: 'hello\n',
      binary: false,
      tooLarge: false,
    })
  })

  it('commit: first parent vs commit, renames, root commit and deletions', async () => {
    const repo = createFixtureRepo()
    const root = repo.commit('root', { 'a.txt': 'v1\n', 'gone.txt': 'g\n' })
    expect(await getFileContents(repo.dir, { kind: 'commit', sha: root, path: 'a.txt' })).toMatchObject({
      oldText: null,
      newText: 'v1\n',
    })
    const c2 = repo.commit('edit', { 'a.txt': 'v2\n' })
    expect(await getFileContents(repo.dir, { kind: 'commit', sha: c2, path: 'a.txt' })).toMatchObject({
      oldText: 'v1\n',
      newText: 'v2\n',
    })
    repo.git(['mv', 'a.txt', 'b.txt'])
    repo.git(['rm', '-q', 'gone.txt'])
    const c3 = repo.commit('rename')
    expect(
      await getFileContents(repo.dir, { kind: 'commit', sha: c3, path: 'b.txt', oldPath: 'a.txt' }),
    ).toMatchObject({ oldText: 'v2\n', newText: 'v2\n' })
    expect(await getFileContents(repo.dir, { kind: 'commit', sha: c3.slice(0, 10), path: 'gone.txt' })).toMatchObject({
      oldText: 'g\n',
      newText: null,
    })
  })

  it('detects binary content on either side', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'bin.dat': Buffer.from([1, 2, 0, 3]), 'text.txt': 'text\n' })
    expect(await getFileContents(repo.dir, { kind: 'commit', sha: repo.head(), path: 'bin.dat' })).toEqual({
      oldText: null,
      newText: null,
      binary: true,
      tooLarge: false,
    })
    repo.write('text.txt', Buffer.from([0x61, 0, 0x62]))
    expect(await getFileContents(repo.dir, { kind: 'unstaged', path: 'text.txt' })).toMatchObject({
      oldText: null,
      newText: null,
      binary: true,
    })
  })

  it('reports content larger than maxBytes as tooLarge', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'big.txt': 'x'.repeat(2000) })
    repo.write('big.txt', 'small\n')
    expect(await getFileContents(repo.dir, { kind: 'unstaged', path: 'big.txt' }, { maxBytes: 1000 })).toEqual({
      oldText: null,
      newText: null,
      binary: false,
      tooLarge: true,
    })
    repo.write('big.txt', 'y'.repeat(2000))
    expect(await getFileContents(repo.dir, { kind: 'unstaged', path: 'big.txt' }, { maxBytes: 1999 })).toMatchObject({
      tooLarge: true,
    })
    expect(await getFileContents(repo.dir, { kind: 'unstaged', path: 'big.txt' }, { maxBytes: 2000 })).toMatchObject({
      tooLarge: false,
      newText: 'y'.repeat(2000),
    })
  })

  it('uses the "ours" stage as the old side of an unmerged file', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const c = await getFileContents(repo.dir, { kind: 'unstaged', path })
    expect(c.oldText).toBe('ours\n')
    expect(c.newText).toContain('<<<<<<<')
  })

  it.skipIf(process.platform === 'win32')('returns the link target of a symlink instead of following it', async () => {
    const repo = createFixtureRepo()
    const outside = makeTempDir('gitbob-outside-')
    repo.commit('init', { 'a.txt': 'x\n' })
    symlinkSync(join(outside, 'secret'), join(repo.dir, 'link'))
    const c = await getFileContents(repo.dir, { kind: 'untracked', path: 'link' })
    expect(c.newText).toBe(join(outside, 'secret'))
  })

  it.skipIf(process.platform === 'win32')('refuses paths through a symlinked directory leaving the repo', async () => {
    const repo = createFixtureRepo()
    const outside = makeTempDir('gitbob-outside-')
    repo.commit('init', { 'a.txt': 'x\n' })
    symlinkSync(outside, join(repo.dir, 'linkdir'))
    await expectGitError(getFileContents(repo.dir, { kind: 'untracked', path: 'linkdir/file' }), 'INVALID_ARGUMENT')
  })

  it('validates paths, commit ids and options-looking input', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'x\n' })
    await expectGitError(getFileContents(repo.dir, { kind: 'unstaged', path: '../x' }), 'INVALID_ARGUMENT')
    await expectGitError(getFileContents(repo.dir, { kind: 'untracked', path: '.git/config' }), 'INVALID_ARGUMENT')
    await expectGitError(getFileContents(repo.dir, { kind: 'commit', sha: '--all', path: 'a.txt' }), 'INVALID_ARGUMENT')
    await expectGitError(getFileContents(repo.dir, { kind: 'commit', sha: 'deadbeef', path: 'a.txt' }), 'NOT_FOUND')
    // A path that looks like an option or stage spec is just a missing file.
    expect(await getFileContents(repo.dir, { kind: 'staged', path: '--output=x' })).toMatchObject({
      oldText: null,
      newText: null,
    })
    expect(await getFileContents(repo.dir, { kind: 'staged', path: '1:a.txt' })).toMatchObject({
      oldText: null,
      newText: null,
    })
  })
})

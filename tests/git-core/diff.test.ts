import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getFileDiff, parseUnifiedDiff, parseUnifiedDiffFiles, unquoteGitPath } from '@git-core/diff'
import { GitError } from '@git-core/errors'
import type { DiffLine } from '@shared/types'
import { cleanupFixtures, createFixtureRepo, isolateProcessGitEnv } from '../helpers/fixture'

let restoreEnv: () => void
beforeAll(() => {
  restoreEnv = isolateProcessGitEnv()
})
afterAll(() => restoreEnv())
afterEach(() => cleanupFixtures())

const compact = (lines: DiffLine[]): string[] =>
  lines.map((l) => `${l.type}:${l.oldLine ?? '-'}:${l.newLine ?? '-'}:${l.content}`)

async function expectGitError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error(`expected rejection with ${code}`)
    },
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).code).toBe(code)
}

describe('parseUnifiedDiff', () => {
  it('parses multiple hunks with correct line numbers', () => {
    const text = [
      'diff --git a/f.txt b/f.txt',
      'index 1111111..2222222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@ heading',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '@@ -10,2 +10,3 @@',
      ' ten',
      '+ten and a half',
      ' eleven',
      '',
    ].join('\n')
    const d = parseUnifiedDiff(text)
    expect(d).toMatchObject({ path: 'f.txt', binary: false, isNew: false, isDeleted: false })
    expect(d.oldPath).toBeUndefined()
    expect(d.hunks).toHaveLength(2)
    expect(d.hunks[0]).toMatchObject({ header: '@@ -1,3 +1,3 @@ heading', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 })
    expect(compact(d.hunks[0]!.lines)).toEqual(['context:1:1:one', 'del:2:-:two', 'add:-:2:TWO', 'context:3:3:three'])
    expect(compact(d.hunks[1]!.lines)).toEqual(['context:10:10:ten', 'add:-:11:ten and a half', 'context:11:12:eleven'])
  })

  it('handles omitted counts, no-newline markers and content that looks like headers', () => {
    const text = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1 +1,2 @@',
      '-old',
      '\\ No newline at end of file',
      '+--- a/not-a-header',
      '+diff --git x y',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const d = parseUnifiedDiff(text)
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 })
    expect(compact(d.hunks[0]!.lines)).toEqual([
      'del:1:-:old',
      'no-newline:-:-:No newline at end of file',
      'add:-:1:--- a/not-a-header',
      'add:-:2:diff --git x y',
      'no-newline:-:-:No newline at end of file',
    ])
    expect(parseUnifiedDiffFiles(text)).toHaveLength(1)
  })

  it('detects new, deleted, binary and renamed files', () => {
    const created = parseUnifiedDiff(
      'diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..1\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n',
    )
    expect(created).toMatchObject({ path: 'n.txt', isNew: true, isDeleted: false })
    expect(created.oldPath).toBeUndefined()
    expect(compact(created.hunks[0]!.lines)).toEqual(['add:-:1:hi'])

    const deleted = parseUnifiedDiff(
      'diff --git a/d.txt b/d.txt\ndeleted file mode 100644\n--- a/d.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n',
    )
    expect(deleted).toMatchObject({ path: 'd.txt', isNew: false, isDeleted: true })
    expect(compact(deleted.hunks[0]!.lines)).toEqual(['del:1:-:a', 'del:2:-:b'])

    const bin = parseUnifiedDiff('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n')
    expect(bin).toMatchObject({ binary: true, hunks: [] })
    expect(parseUnifiedDiff('diff --git a/i b/i\nGIT binary patch\nliteral 3\nKcmZ\n').binary).toBe(true)

    const renamed = parseUnifiedDiff(
      [
        'diff --git a/old name.txt b/new name.txt',
        'similarity index 80%',
        'rename from old name.txt',
        'rename to new name.txt',
        '--- a/old name.txt',
        '+++ b/new name.txt',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '',
      ].join('\n'),
    )
    expect(renamed).toMatchObject({ path: 'new name.txt', oldPath: 'old name.txt' })
  })

  it('unquotes C-quoted paths', () => {
    expect(unquoteGitPath('"tab\\there"')).toBe('tab\there')
    expect(unquoteGitPath('"\\303\\251t\\303\\251.txt"')).toBe('été.txt')
    expect(unquoteGitPath('"q\\"uote\\\\"')).toBe('q"uote\\')
    expect(unquoteGitPath('plain.txt')).toBe('plain.txt')
    const d = parseUnifiedDiff('diff --git "a/t\\tx" "b/t\\tx"\n--- "a/t\\tx"\n+++ "b/t\\tx"\n@@ -1 +1 @@\n-a\n+b\n')
    expect(d.path).toBe('t\tx')
  })

  it('returns an empty diff for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual({ binary: false, isNew: false, isDeleted: false, hunks: [] })
  })
})

describe('getFileDiff', () => {
  it('diffs unstaged and staged changes separately', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'f é.txt': 'one\ntwo\nthree\n' })
    repo.write('f é.txt', 'one\nTWO\nthree\n')
    repo.git(['add', 'f é.txt'])
    repo.write('f é.txt', 'one\nTWO\nthree\nfour')

    const staged = await getFileDiff(repo.dir, { kind: 'staged', path: 'f é.txt' })
    expect(staged).toMatchObject({ path: 'f é.txt', binary: false, isNew: false, isDeleted: false, truncated: false })
    expect(compact(staged.hunks[0]!.lines)).toEqual([
      'context:1:1:one',
      'del:2:-:two',
      'add:-:2:TWO',
      'context:3:3:three',
    ])

    const unstaged = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f é.txt' })
    expect(compact(unstaged.hunks[0]!.lines)).toEqual([
      'context:1:1:one',
      'context:2:2:TWO',
      'context:3:3:three',
      'add:-:4:four',
      'no-newline:-:-:No newline at end of file',
    ])

    const none = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'missing.txt' })
    expect(none).toMatchObject({ hunks: [], isNew: false, isDeleted: false, binary: false })
  })

  it('diffs a staged rename when oldPath is given', async () => {
    const repo = createFixtureRepo()
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
    repo.commit('init', { 'old name.txt': body, 'edited.txt': body })
    repo.git(['mv', 'old name.txt', 'new name.txt'])
    repo.git(['rm', '-q', 'edited.txt'])
    repo.write('dir/edited2.txt', body.replace('line 3\n', 'line three\n'))
    repo.git(['add', 'dir/edited2.txt'])

    // Pure rename: no hunks, old path reported.
    const pure = await getFileDiff(repo.dir, { kind: 'staged', path: 'new name.txt', oldPath: 'old name.txt' })
    expect(pure).toMatchObject({ path: 'new name.txt', oldPath: 'old name.txt', isNew: false, isDeleted: false, hunks: [] })

    // Rename with an edit: hunks of the content change only.
    const edited = await getFileDiff(repo.dir, { kind: 'staged', path: 'dir/edited2.txt', oldPath: 'edited.txt' })
    expect(edited).toMatchObject({ path: 'dir/edited2.txt', oldPath: 'edited.txt', isNew: false })
    expect(edited.hunks).toHaveLength(1)
    expect(edited.hunks[0]!.lines.filter((l) => l.type !== 'context').map((l) => `${l.type}:${l.content}`)).toEqual([
      'del:line 3',
      'add:line three',
    ])

    // Without oldPath the new path still diffs as an added file, as before.
    const added = await getFileDiff(repo.dir, { kind: 'staged', path: 'new name.txt' })
    expect(added).toMatchObject({ path: 'new name.txt', isNew: true })
    expect(added.oldPath).toBeUndefined()
    expect(added.hunks[0]!.lines).toHaveLength(20)

    // oldPath equal to path is ignored; invalid oldPath is rejected.
    const same = await getFileDiff(repo.dir, { kind: 'staged', path: 'new name.txt', oldPath: 'new name.txt' })
    expect(same).toMatchObject({ isNew: true })
    await expectGitError(getFileDiff(repo.dir, { kind: 'staged', path: 'new name.txt', oldPath: '../x' }), 'INVALID_ARGUMENT')
  })

  it('diffs staged files on an unborn branch and deleted files', async () => {
    const repo = createFixtureRepo()
    repo.write('a.txt', 'a\n')
    repo.git(['add', 'a.txt'])
    const d = await getFileDiff(repo.dir, { kind: 'staged', path: 'a.txt' })
    expect(d).toMatchObject({ isNew: true })
    expect(compact(d.hunks[0]!.lines)).toEqual(['add:-:1:a'])

    repo.git(['commit', '-q', '-m', 'one'])
    rmSync(join(repo.dir, 'a.txt'))
    const del = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'a.txt' })
    expect(del).toMatchObject({ isDeleted: true, path: 'a.txt' })
    expect(compact(del.hunks[0]!.lines)).toEqual(['del:1:-:a'])
  })

  it('diffs untracked and binary files', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    repo.write('dir/new file.txt', 'x\ny\n')
    repo.write('bin.dat', Buffer.from([0, 1, 2, 0, 255]))
    const u = await getFileDiff(repo.dir, { kind: 'untracked', path: 'dir/new file.txt' })
    expect(u).toMatchObject({ path: 'dir/new file.txt', isNew: true, binary: false })
    expect(compact(u.hunks[0]!.lines)).toEqual(['add:-:1:x', 'add:-:2:y'])

    const b = await getFileDiff(repo.dir, { kind: 'untracked', path: 'bin.dat' })
    expect(b).toMatchObject({ binary: true, hunks: [] })

    await expectGitError(getFileDiff(repo.dir, { kind: 'untracked', path: '../etc/passwd' }), 'INVALID_ARGUMENT')
  })

  it('diffs a root commit, a normal commit with a rename, and a merge commit', async () => {
    const repo = createFixtureRepo()
    const body = Array.from({ length: 9 }, (_, i) => `shared line number ${i + 1}`).join('\n') + '\n'
    const root = repo.commit('root', { 'a.txt': body + 'last\n' })
    const r = await getFileDiff(repo.dir, { kind: 'commit', sha: root, path: 'a.txt' })
    expect(r).toMatchObject({ isNew: true })
    expect(r.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 10 })

    repo.git(['mv', 'a.txt', 'b.txt'])
    const ren = repo.commit('rename', { 'b.txt': body + 'last changed\n' })
    const rd = await getFileDiff(repo.dir, { kind: 'commit', sha: ren, path: 'b.txt', oldPath: 'a.txt' })
    expect(rd).toMatchObject({ path: 'b.txt', oldPath: 'a.txt', isNew: false })
    expect(compact(rd.hunks[0]!.lines).slice(-2)).toEqual(['del:10:-:last', 'add:-:10:last changed'])

    repo.branch('side')
    repo.commit('main change', { 'm.txt': 'main\n' })
    repo.checkout('side')
    repo.commit('side change', { 's.txt': 'side\n' })
    repo.checkout('main')
    const merge = repo.merge('side')
    // Against the first parent, the merge introduces s.txt but not m.txt.
    const ms = await getFileDiff(repo.dir, { kind: 'commit', sha: merge, path: 's.txt' })
    expect(ms).toMatchObject({ isNew: true })
    expect(compact(ms.hunks[0]!.lines)).toEqual(['add:-:1:side'])
    const mm = await getFileDiff(repo.dir, { kind: 'commit', sha: merge, path: 'm.txt' })
    expect(mm.hunks).toEqual([])

    await expectGitError(getFileDiff(repo.dir, { kind: 'commit', sha: 'HEAD', path: 'a.txt' }), 'INVALID_ARGUMENT')
    await expectGitError(getFileDiff(repo.dir, { kind: 'commit', sha: 'deadbeef', path: 'a.txt' }), 'NOT_FOUND')
  })

  it('truncates large output instead of failing', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n') + '\n'
    repo.write('big.txt', big)
    const d = await getFileDiff(repo.dir, { kind: 'untracked', path: 'big.txt' }, { maxBytes: 4096 })
    expect(d.truncated).toBe(true)
    expect(d.hunks).toHaveLength(1)
    const lines = d.hunks[0]!.lines
    expect(lines.length).toBeGreaterThan(10)
    expect(lines.length).toBeLessThan(2000)
    lines.forEach((l, i) => {
      expect(l).toEqual({ type: 'add', content: `line ${i} ${'x'.repeat(40)}`, oldLine: null, newLine: i + 1 })
    })

    const full = await getFileDiff(repo.dir, { kind: 'untracked', path: 'big.txt' })
    expect(full.truncated).toBe(false)
    expect(full.hunks[0]!.lines).toHaveLength(2000)
  })
})

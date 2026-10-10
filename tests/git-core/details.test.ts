import { afterEach, describe, expect, it } from 'vitest'
import { getCommitDetails, parseNameStatus, parseNumstat } from '@git-core/details'
import { GitError } from '@git-core/errors'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(() => {
  cleanupFixtures()
})

const byPath = <T extends { path: string }>(files: T[]): T[] => [...files].sort((a, b) => a.path.localeCompare(b.path))

describe('parseNameStatus / parseNumstat', () => {
  it('parses plain and rename entries', () => {
    expect(parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0A\0b c.txt\0')).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'R', path: 'new.txt', oldPath: 'old.txt' },
      { status: 'A', path: 'b c.txt' },
    ])
    expect(parseNameStatus('')).toEqual([])
  })

  it('parses numstat including binary and renames', () => {
    const m = parseNumstat('3\t1\ta.txt\0-\t-\timg.bin\0' + '0\t0\t\0old.txt\0new.txt\0')
    expect(m.get('a.txt')).toEqual({ additions: 3, deletions: 1 })
    expect(m.get('img.bin')).toEqual({ additions: null, deletions: null })
    expect(m.get('new.txt')).toEqual({ additions: 0, deletions: 0 })
    expect(m.has('old.txt')).toBe(false)
  })

  it('keeps tabs that are part of a path', () => {
    const m = parseNumstat('1\t0\ta\tb.txt\0')
    expect(m.get('a\tb.txt')).toEqual({ additions: 1, deletions: 0 })
  })
})

describe('getCommitDetails', () => {
  it('lists added files for the root commit', async () => {
    const repo = createFixtureRepo()
    const sha = repo.commit('root', { 'a.txt': 'one\ntwo\n', 'dir/b.txt': 'x\n' })
    const d = await getCommitDetails(repo.dir, sha)
    expect(d.sha).toBe(sha)
    expect(d.parents).toEqual([])
    expect(byPath(d.files)).toEqual([
      { status: 'A', path: 'a.txt', additions: 2, deletions: 0 },
      { status: 'A', path: 'dir/b.txt', additions: 1, deletions: 0 },
    ])
  })

  it('reports modify, delete and rename with line counts', async () => {
    const repo = createFixtureRepo()
    const renamed = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
    repo.commit('base', { 'mod.txt': 'a\nb\nc\n', 'del.txt': 'gone\nsoon\n', 'old-name.txt': renamed })
    repo.write('mod.txt', 'a\nB\nc\nd\n')
    repo.git(['rm', '-q', 'del.txt'])
    repo.git(['mv', 'old-name.txt', 'new-name.txt'])
    const sha = repo.commit('changes', { 'mod.txt': 'a\nB\nc\nd\n' })
    const d = await getCommitDetails(repo.dir, sha)
    expect(byPath(d.files)).toEqual([
      { status: 'D', path: 'del.txt', additions: 0, deletions: 2 },
      { status: 'M', path: 'mod.txt', additions: 2, deletions: 1 },
      { status: 'R', path: 'new-name.txt', oldPath: 'old-name.txt', additions: 0, deletions: 0 },
    ])
  })

  it('reports binary files with null line counts', async () => {
    const repo = createFixtureRepo()
    const sha = repo.commit('bin', { 'img.bin': Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]), 't.txt': 'x\n' })
    const d = await getCommitDetails(repo.dir, sha)
    expect(byPath(d.files)).toEqual([
      { status: 'A', path: 'img.bin', additions: null, deletions: null },
      { status: 'A', path: 't.txt', additions: 1, deletions: 0 },
    ])
  })

  it('preserves a multi-line body separate from the subject', async () => {
    const repo = createFixtureRepo()
    const body = 'First paragraph line 1\nline 2\n\n  indented paragraph\n- bullet "quoted" é 🚀'
    const sha = repo.commit(`The subject\n\n${body}\n`)
    const d = await getCommitDetails(repo.dir, sha)
    expect(d.subject).toBe('The subject')
    expect(d.body).toBe(body)
    expect(d).toMatchObject({
      authorName: 'Test Author',
      authorEmail: 'author@example.com',
      committerName: 'Test Committer',
      committerEmail: 'committer@example.com',
    })
    expect(d.authorTime).toBe(Number(repo.git(['log', '-1', '--format=%at', sha])))
    expect(d.commitTime).toBe(Number(repo.git(['log', '-1', '--format=%ct', sha])))
  })

  it('returns an empty body for a subject-only commit', async () => {
    const repo = createFixtureRepo()
    const sha = repo.commit('only subject')
    const d = await getCommitDetails(repo.dir, sha)
    expect(d.body).toBe('')
    expect(d.files).toEqual([])
  })

  it('compares merge commits against the first parent', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'shared.txt': 'base\n' })
    repo.branch('feature')
    const m1 = repo.commit('main change', { 'main.txt': 'main\n' })
    repo.checkout('feature')
    const f1 = repo.commit('feature change', { 'feature.txt': 'f1\nf2\n' })
    repo.checkout('main')
    const merge = repo.merge('feature')
    const d = await getCommitDetails(repo.dir, merge)
    expect(d.parents).toEqual([m1, f1])
    // Only what the merge brought in relative to main; main.txt is unchanged vs first parent.
    expect(d.files).toEqual([{ status: 'A', path: 'feature.txt', additions: 2, deletions: 0 }])
  })

  it('accepts an abbreviated sha and returns the full sha', async () => {
    const repo = createFixtureRepo()
    const sha = repo.commit('abbrev', { 'a.txt': 'a\n' })
    const d = await getCommitDetails(repo.dir, sha.slice(0, 8))
    expect(d.sha).toBe(sha)
    const upper = await getCommitDetails(repo.dir, sha.toUpperCase())
    expect(upper.sha).toBe(sha)
  })

  it.each(['--all', 'HEAD', 'abc', 'zzzz', '', 'HEAD~1', 'abcd^', 'abcd..ef01', `${'a'.repeat(40)} `, '-abcd', 'a'.repeat(65)])(
    'rejects %j with INVALID_ARGUMENT',
    async (bad) => {
      const repo = createFixtureRepo()
      repo.commit('one')
      await expect(getCommitDetails(repo.dir, bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    },
  )

  it('rejects an unknown sha with NOT_FOUND', async () => {
    const repo = createFixtureRepo()
    repo.commit('one')
    const err = await getCommitDetails(repo.dir, 'deadbeef'.repeat(5)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as GitError).code).toBe('NOT_FOUND')
  })

  it('rejects a sha that names a non-commit object with NOT_FOUND', async () => {
    const repo = createFixtureRepo()
    repo.commit('one', { 'a.txt': 'a\n' })
    const blob = repo.rev('HEAD:a.txt')
    await expect(getCommitDetails(repo.dir, blob)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // Windows file names cannot contain these characters (" * : tab).

  it.skipIf(process.platform === 'win32')('handles file names with spaces, unicode and special characters', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'old file.txt': 'same content for rename detection\nline2\nline3\n' })
    repo.git(['mv', 'old file.txt', 'nëw fïle 🚀.txt'])
    const sha = repo.commit('weird names', {
      'with space.txt': 'a\n',
      'ünïcödé/日本語.md': 'b\nc\n',
      'tab\tand"quote.txt': 'd\n',
    })
    const d = await getCommitDetails(repo.dir, sha)
    expect(byPath(d.files)).toEqual(
      byPath([
        { status: 'R', path: 'nëw fïle 🚀.txt', oldPath: 'old file.txt', additions: 0, deletions: 0 },
        { status: 'A', path: 'with space.txt', additions: 1, deletions: 0 },
        { status: 'A', path: 'ünïcödé/日本語.md', additions: 2, deletions: 0 },
        { status: 'A', path: 'tab\tand"quote.txt', additions: 1, deletions: 0 },
      ]),
    )
  })
})

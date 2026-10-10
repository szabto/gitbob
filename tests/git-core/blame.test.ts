import { afterEach, describe, expect, it } from 'vitest'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getBlame, MAX_BLAME_LINES, parseBlamePorcelain, UNCOMMITTED_SHA } from '@git-core/blame'
import { cleanupFixtures, createFixtureRepo, type FixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

function commitAs(repo: FixtureRepo, author: string, message: string, files: Record<string, string>): string {
  for (const [p, c] of Object.entries(files)) repo.write(p, c)
  repo.git(['add', '-A'])
  repo.git(['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_DATE: '1700000500 +0000' })
  return repo.head()
}

describe('getBlame', () => {
  it('attributes lines to multiple authors', async () => {
    const repo = createFixtureRepo()
    const c1 = commitAs(repo, 'Alice', 'first', { 'f.txt': 'one\ntwo\nthree\n' })
    const c2 = commitAs(repo, 'Bob', 'second\n\nbody', { 'f.txt': 'one\nTWO\nthree\nfour\n' })
    const { lines, text } = await getBlame(repo.dir, 'f.txt')
    expect(text).toEqual(['one', 'TWO', 'three', 'four'])
    expect(lines.map((l) => [l.line, l.sha, l.authorName])).toEqual([
      [1, c1, 'Alice'],
      [2, c2, 'Bob'],
      [3, c1, 'Alice'],
      [4, c2, 'Bob'],
    ])
    expect(lines[0]).toMatchObject({ summary: 'first', boundary: true, originalLine: 1, authorTime: 1700000500 })
    expect(lines[1]).toMatchObject({ summary: 'second', boundary: false, originalLine: 2 })
    // Repeated sha (header omitted by git) still carries the commit info.
    expect(lines[2]).toMatchObject({ summary: 'first', originalLine: 3 })
  })

  it('reports uncommitted lines with the zero sha', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('first', { 'f.txt': 'a\nb\n' })
    repo.write('f.txt', 'a\nchanged\nnew\n')
    const { lines, text } = await getBlame(repo.dir, 'f.txt')
    expect(text).toEqual(['a', 'changed', 'new'])
    expect(lines[0]!.sha).toBe(c1)
    expect(lines[1]).toMatchObject({ sha: UNCOMMITTED_SHA, authorName: 'Not Committed Yet' })
    expect(lines[2]).toMatchObject({ sha: UNCOMMITTED_SHA, authorName: 'Not Committed Yet' })
  })

  it('blames a past revision', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('first', { 'f.txt': 'a\nb\n' })
    repo.commit('second', { 'f.txt': 'x\n' })
    const { lines, text } = await getBlame(repo.dir, 'f.txt', c1.slice(0, 8))
    expect(text).toEqual(['a', 'b'])
    expect(lines.every((l) => l.sha === c1)).toBe(true)
  })

  it('follows lines across a rename', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('first', { 'old.txt': 'keep 1\nkeep 2\nkeep 3\n' })
    repo.git(['mv', 'old.txt', 'new name.txt'])
    repo.commit('rename')
    const c3 = repo.commit('edit', { 'new name.txt': 'keep 1\nkeep 2\nkeep 3\nadded\n' })
    const { lines } = await getBlame(repo.dir, 'new name.txt')
    expect(lines.map((l) => l.sha)).toEqual([c1, c1, c1, c3])
  })

  it('handles CRLF, tabs and empty files', async () => {
    const repo = createFixtureRepo()
    repo.commit('first', { 'crlf.txt': 'a\r\n\tb\r\n', 'empty.txt': '' })
    expect((await getBlame(repo.dir, 'crlf.txt')).text).toEqual(['a', '\tb'])
    expect(await getBlame(repo.dir, 'empty.txt')).toEqual({ lines: [], text: [] })
  })

  it('validates paths, revisions and content', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('first', { 'f.txt': 'a\n', 'bin.dat': Buffer.from([1, 0, 2, 0]) })
    for (const bad of ['', '../x', '/etc/passwd', 'a/../../x']) {
      await expect(getBlame(repo.dir, bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(getBlame(repo.dir, 'f.txt', '--since=1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(getBlame(repo.dir, 'f.txt', 'HEAD')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(getBlame(repo.dir, 'f.txt', 'deadbeef')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(getBlame(repo.dir, 'missing.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(getBlame(repo.dir, 'missing.txt', c1)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(getBlame(repo.dir, 'bin.dat')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/binary/) })
    await expect(getBlame(repo.dir, 'bin.dat', c1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/binary/) })
    repo.write('untracked.txt', 'u\n')
    await expect(getBlame(repo.dir, 'untracked.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('does not follow a symlink out of the repository', async () => {
    const repo = createFixtureRepo()
    symlinkSync('/etc/hosts', join(repo.dir, 'link'))
    repo.commit('link', { 'f.txt': 'a\n' })
    repo.git(['add', 'link'])
    repo.commit('add link')
    const { text } = await getBlame(repo.dir, 'link')
    expect(text).toEqual(['/etc/hosts'])
  })

  it('rejects files that are too large', async () => {
    const repo = createFixtureRepo()
    const big = 'x\n'.repeat(MAX_BLAME_LINES + 1)
    const c1 = repo.commit('big', { 'big.txt': big })
    await expect(getBlame(repo.dir, 'big.txt')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/too large/) })
    await expect(getBlame(repo.dir, 'big.txt', c1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/too large/) })
  })
})

describe('parseBlamePorcelain', () => {
  it('treats content lines that look like headers as content', () => {
    const sha = 'a'.repeat(40)
    const out = [
      `${sha} 1 1 2`,
      'author A',
      'author-time 5',
      'summary s',
      'filename f',
      `\t${sha} 2 2`,
      `${sha} 2 2`,
      '\tsummary x',
      '',
    ].join('\n')
    const r = parseBlamePorcelain(out)
    expect(r.text).toEqual([`${sha} 2 2`, 'summary x'])
    expect(r.lines.map((l) => l.summary)).toEqual(['s', 's'])
  })
})

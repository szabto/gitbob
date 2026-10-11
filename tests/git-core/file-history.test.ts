import { afterEach, describe, expect, it } from 'vitest'
import { getFileHistory, parseFileHistory } from '@git-core/file-history'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

describe('file history', () => {
  it('lists commits that changed a file, newest first, following renames', async () => {
    const repo = createFixtureRepo()
    const body = 'line one\nline two\nline three\nline four\nline five\n'
    const one = repo.commit('add old', { 'old.txt': body, 'other.txt': 'x' })
    repo.commit('unrelated', { 'other.txt': 'y' })
    repo.git(['mv', 'old.txt', 'new.txt'])
    const two = repo.commit('rename')
    const three = repo.commit('edit;\twith "quotes" \x01 inside', { 'new.txt': body + 'six\n' })
    const page = await getFileHistory(repo.dir, 'new.txt')
    expect(page.hasMore).toBe(false)
    expect(page.entries.map((e) => [e.commit.sha, e.status, e.path, e.oldPath])).toEqual([
      [three, 'M', 'new.txt', undefined],
      [two, 'R', 'new.txt', 'old.txt'],
      [one, 'A', 'old.txt', undefined],
    ])
    expect(page.entries[0]!.commit.subject).toBe('edit;\twith "quotes" \x01 inside')
  })

  it('pages with skip and reports hasMore', async () => {
    const repo = createFixtureRepo()
    for (let i = 0; i < 5; i++) repo.commit(`c${i}`, { 'f.txt': String(i) })
    const all = await getFileHistory(repo.dir, 'f.txt', { limit: 2 })
    expect(all.entries.map((e) => e.commit.subject)).toEqual(['c4', 'c3'])
    expect(all.hasMore).toBe(true)
    const last = await getFileHistory(repo.dir, 'f.txt', { skip: 4, limit: 2 })
    expect(last.entries.map((e) => e.commit.subject)).toEqual(['c0'])
    expect(last.hasMore).toBe(false)
  })

  it('handles unborn branches, missing files and paths that look like options or globs', async () => {
    const empty = createFixtureRepo()
    expect(await getFileHistory(empty.dir, 'a.txt')).toEqual({ entries: [], hasMore: false })
    const repo = createFixtureRepo()
    repo.commit('base', { '-n.txt': '1', '*.txt': '2', 'b.txt': '3' })
    expect((await getFileHistory(repo.dir, 'missing.txt')).entries).toEqual([])
    expect((await getFileHistory(repo.dir, '-n.txt')).entries).toHaveLength(1)
    expect((await getFileHistory(repo.dir, '*.txt')).entries.map((e) => e.path)).toEqual(['*.txt'])
    await expect(getFileHistory(repo.dir, '../outside')).rejects.toThrow()
  })

  it('rejects malformed output', () => {
    expect(() => parseFileHistory('garbage')).toThrow(/Malformed/)
  })
})

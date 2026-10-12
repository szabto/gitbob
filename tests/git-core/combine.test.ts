import { afterEach, describe, expect, it } from 'vitest'
import { combineCommits } from '@git-core/combine'
import { getFileDiff } from '@git-core/diff'
import { getFileContents } from '@git-core/contents'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

const paths = (r: { files: { path: string; status: string }[] }) => r.files.map((f) => `${f.status} ${f.path}`).sort()

function linear() {
  const repo = createFixtureRepo()
  const c0 = repo.commit('base', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  const c1 = repo.commit('one', { 'a.txt': 'a1\n' })
  const c2 = repo.commit('two', { 'b.txt': 'b1\n' })
  const c3 = repo.commit('three', { 'c.txt': 'c\n' })
  const c4 = repo.commit('four', { 'd.txt': 'd\n' })
  return { repo, c0, c1, c2, c3, c4 }
}

describe('combineCommits', () => {
  it('an unbroken stretch is the exact oldest^..newest range', async () => {
    const { repo, c0, c1, c2, c3 } = linear()
    const r = await combineCommits(repo.dir, [c3, c2, c1]) // graph order: newest first
    expect(r).toMatchObject({ mode: 'contiguous', base: c0, head: c3 })
    expect(paths(r)).toEqual(['A c.txt', 'M a.txt', 'M b.txt'])
  })

  it('separate commits combine only their own changes, leaving out the ones between', async () => {
    const { repo, c0, c1, c3 } = linear()
    const status = repo.git(['status', '--porcelain'])
    const refs = repo.git(['for-each-ref'])
    const r = await combineCommits(repo.dir, [c3, c1])
    expect(r.mode).toBe('combined')
    expect(r.base).toBe(c0)
    expect(paths(r)).toEqual(['A c.txt', 'M a.txt']) // not b.txt from c2
    // The diff opens against the helper commit like any range.
    const diff = await getFileDiff(repo.dir, { kind: 'range', base: r.base, head: r.head, path: 'a.txt' })
    expect(diff.hunks.flatMap((h) => h.lines).find((l) => l.type === 'add')?.content).toBe('a1')
    expect((await getFileContents(repo.dir, { kind: 'range', base: r.base, head: r.head, path: 'b.txt' })).newText).toBe('b0\n')
    // Nothing in the repository changed.
    expect(repo.git(['status', '--porcelain'])).toBe(status)
    expect(repo.git(['for-each-ref'])).toBe(refs)
    // Same input, same helper commit.
    expect((await combineCommits(repo.dir, [c3, c1])).head).toBe(r.head)
  })

  it('includes a root commit, diffing it against nothing', async () => {
    const { repo, c0, c2 } = linear()
    const contiguous = await combineCommits(repo.dir, [c0])
    expect(contiguous.mode).toBe('contiguous')
    expect(paths(contiguous)).toEqual(['A a.txt', 'A b.txt'])
    const combined = await combineCommits(repo.dir, [c2, c0])
    expect(combined.mode).toBe('combined')
    expect(paths(combined)).toEqual(['A a.txt', 'A b.txt'])
    const b = await getFileContents(repo.dir, { kind: 'range', base: combined.base, head: combined.head, path: 'b.txt' })
    expect(b.newText).toBe('b1\n')
  })

  it('combines commits from different branches', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'shared.txt': 's\n' })
    repo.branch('feature')
    const m = repo.commit('main work', { 'main.txt': 'm\n' })
    repo.checkout('feature')
    const f = repo.commit('feature work', { 'feature.txt': 'f\n' })
    const r = await combineCommits(repo.dir, [f, m])
    expect(r.base).toBe(base)
    expect(paths(r)).toEqual(['A feature.txt', 'A main.txt'])
  })

  it('explains when a commit depends on one that was left out, and the whole range still works', async () => {
    const repo = createFixtureRepo()
    const c0 = repo.commit('base', { 'a.txt': 'line\n' })
    repo.commit('middle', { 'a.txt': 'middle\n' })
    const c2 = repo.commit('builds on middle', { 'a.txt': 'last\n' })
    const c3 = repo.commit('other', { 'z.txt': 'z\n' })
    await expect(combineCommits(repo.dir, [c2, c0])).rejects.toMatchObject({ message: expect.stringContaining("can't be combined"), detail: expect.stringContaining('a.txt') })
    const whole = await combineCommits(repo.dir, [c3, c0], { wholeRange: true })
    expect(whole.mode).toBe('range')
    expect(whole.head).toBe(c3)
  })

  it('rejects unknown commits', async () => {
    const { repo, c1 } = linear()
    await expect(combineCommits(repo.dir, [c1, 'deadbeefdeadbeef'])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(combineCommits(repo.dir, [])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { getRangeFiles, mergeBase } from '@git-core/range'
import { getFileDiff } from '@git-core/diff'
import { getFileContents } from '@git-core/contents'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

function prRepo() {
  const repo = createFixtureRepo()
  const base = repo.commit('base', { 'a.txt': 'one\ntwo\n', 'old.txt': 'same content here\n'.repeat(5) })
  repo.branch('feature')
  repo.commit('main moves on', { 'main.txt': 'm\n' })
  repo.checkout('feature')
  repo.git(['mv', 'old.txt', 'new.txt'])
  repo.commit('feature work', { 'a.txt': 'one\nTWO\n', 'added.txt': 'x\n' })
  const head = repo.head()
  return { repo, base, head, main: repo.rev('main') }
}

describe('range diffs (pull requests)', () => {
  it('finds the merge base and the files the branch changed', async () => {
    const { repo, base, head, main } = prRepo()
    expect(await mergeBase(repo.dir, main, head)).toBe(base)
    const files = await getRangeFiles(repo.dir, base, head)
    expect(files.map((f) => [f.status, f.path, f.oldPath ?? null]).sort()).toEqual([
      ['A', 'added.txt', null],
      ['M', 'a.txt', null],
      ['R', 'new.txt', 'old.txt'],
    ])
    expect(files.find((f) => f.path === 'a.txt')).toMatchObject({ additions: 1, deletions: 1 })
  })

  it('diffs and reads a file across the range', async () => {
    const { repo, base, head } = prRepo()
    const diff = await getFileDiff(repo.dir, { kind: 'range', base, head, path: 'a.txt' })
    expect(diff.hunks[0]!.lines.filter((l) => l.type !== 'context').map((l) => l.content)).toEqual(['two', 'TWO'])
    const contents = await getFileContents(repo.dir, { kind: 'range', base, head, path: 'new.txt', oldPath: 'old.txt' })
    expect(contents.oldText).toBe(contents.newText)
  })

  it('rejects unknown and invalid commits', async () => {
    const { repo, base } = prRepo()
    await expect(getRangeFiles(repo.dir, base, 'f'.repeat(40))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(getRangeFiles(repo.dir, base, 'HEAD')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

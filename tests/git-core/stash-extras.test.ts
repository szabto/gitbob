import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyStashFile, createStash, getStashFiles, listStashes, stashToBranch } from '@git-core/stash'
import { getFileDiff } from '@git-core/diff'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

function stashed() {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1\n', 'b.txt': 'b\n' })
  repo.write('a.txt', 'stashed a\n')
  repo.write('b.txt', 'stashed b\n')
  repo.write('new.txt', 'brand new\n')
  return repo
}

describe('stash extras', () => {
  it('stashes only the given files', async () => {
    const repo = stashed()
    expect(await createStash(repo.dir, { includeUntracked: true, paths: ['a.txt'] })).toEqual({ created: true })
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('1\n')
    expect(readFileSync(join(repo.dir, 'b.txt'), 'utf8')).toBe('stashed b\n')
    expect((await getStashFiles(repo.dir, 0)).map((f) => f.path)).toEqual(['a.txt'])
  })

  it('marks untracked stash files so their diff can be shown', async () => {
    const repo = stashed()
    await createStash(repo.dir, { includeUntracked: true })
    const files = await getStashFiles(repo.dir, 0)
    const added = files.find((f) => f.path === 'new.txt')!
    expect(added.untrackedIn).toMatch(/^[0-9a-f]{40}$/)
    const diff = await getFileDiff(repo.dir, { kind: 'commit', sha: added.untrackedIn!, path: 'new.txt' })
    expect(diff.isNew).toBe(true)
    expect(diff.hunks[0]!.lines[0]!.content).toBe('brand new')
    expect(files.find((f) => f.path === 'a.txt')!.untrackedIn).toBeUndefined()
  })

  it('applies one file from a stash and keeps the stash', async () => {
    const repo = stashed()
    await createStash(repo.dir, { includeUntracked: true })
    await applyStashFile(repo.dir, 0, 'a.txt')
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('stashed a\n')
    expect(readFileSync(join(repo.dir, 'b.txt'), 'utf8')).toBe('b\n')
    await applyStashFile(repo.dir, 0, 'new.txt')
    expect(readFileSync(join(repo.dir, 'new.txt'), 'utf8')).toBe('brand new\n')
    expect(await listStashes(repo.dir)).toHaveLength(1)
  })

  it('never overwrites: refuses when the file changed or already exists', async () => {
    const repo = stashed()
    await createStash(repo.dir, { includeUntracked: true })
    repo.write('a.txt', 'my newer work\n')
    await expect(applyStashFile(repo.dir, 0, 'a.txt')).rejects.toThrow(/don't apply/)
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('my newer work\n')
    repo.write('new.txt', 'someone else\n')
    await expect(applyStashFile(repo.dir, 0, 'new.txt')).rejects.toThrow(/already exists/)
    expect(readFileSync(join(repo.dir, 'new.txt'), 'utf8')).toBe('someone else\n')
    await expect(applyStashFile(repo.dir, 0, 'missing.txt')).rejects.toThrow(/not in stash/)
    await expect(applyStashFile(repo.dir, 0, '../x')).rejects.toThrow()
  })

  it('turns a stash into a branch at the commit it was made on', async () => {
    const repo = stashed()
    const base = repo.head()
    await createStash(repo.dir, { includeUntracked: true })
    repo.commit('moved on', { 'a.txt': 'conflicting\n' })
    await stashToBranch(repo.dir, 0, 'rescued')
    expect(repo.git(['branch', '--show-current'])).toBe('rescued')
    expect(repo.head()).toBe(base)
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('stashed a\n')
    expect(existsSync(join(repo.dir, 'new.txt'))).toBe(true)
    expect(await listStashes(repo.dir)).toHaveLength(0)
    await expect(stashToBranch(repo.dir, 0, 'x')).rejects.toThrow()
  })

  it('rejects invalid or existing branch names for stash branch', async () => {
    const repo = stashed()
    await createStash(repo.dir, { includeUntracked: true })
    await expect(stashToBranch(repo.dir, 0, 'bad..name')).rejects.toThrow()
    await expect(stashToBranch(repo.dir, 0, 'main')).rejects.toThrow(/already exists/)
    expect(await listStashes(repo.dir)).toHaveLength(1)
  })
})

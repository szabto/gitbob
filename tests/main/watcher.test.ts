import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { isRelevantChange, RepositoryWatcher } from '../../src/main/watcher'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterAll(cleanupFixtures)

describe('isRelevantChange', () => {
  const root = '/repo'
  const gitDir = '/repo/.git'
  it.each([
    ['/repo/src/a.ts', true],
    ['/repo/.git/index', true],
    ['/repo/.git/HEAD', true],
    ['/repo/.git/refs/heads/main', true],
    ['/repo/.git/packed-refs', true],
    ['/repo/.git/MERGE_HEAD', true],
    ['/repo/.git/objects/ab/cdef', false],
    ['/repo/.git/logs/HEAD', false],
    ['/repo/.git/index.lock', false],
    ['/repo/.git/refs/heads/main.lock', false],
    ['/elsewhere/file', false],
  ])('%s -> %s', (path, expected) => {
    expect(isRelevantChange(root, gitDir, path)).toBe(expected)
  })
})

describe('RepositoryWatcher', () => {
  it('fires once for a burst of worktree changes', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': '1' })
    let calls = 0
    const w = new RepositoryWatcher(repo.dir, join(repo.dir, '.git'), () => calls++, 150)
    w.start()
    try {
      await new Promise((r) => setTimeout(r, 100))
      for (let i = 0; i < 5; i++) repo.write('a.txt', String(i))
      await expect.poll(() => calls, { timeout: 5000 }).toBeGreaterThanOrEqual(1)
      await new Promise((r) => setTimeout(r, 400))
      expect(calls).toBe(1)

      // Staging (index change) is also reported.
      repo.git(['add', 'a.txt'])
      await expect.poll(() => calls, { timeout: 5000 }).toBe(2)
    } finally {
      w.stop()
    }
  })
})

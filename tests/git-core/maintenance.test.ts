import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasCommitGraph, refreshIndexStat, writeCommitGraph } from '@git-core/maintenance'
import { RepoHealth } from '../../src/main/repo-health'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

describe('repository maintenance', () => {
  it('refreshIndexStat updates stale stat data without touching staged content', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n', 'b.txt': '2\n' })
    repo.write('b.txt', 'staged\n')
    repo.git(['add', 'b.txt'])
    const future = new Date(Date.now() + 60_000)
    utimesSync(join(repo.dir, 'a.txt'), future, future)
    // Stat-dirty but content-clean: the low-level check reports it until the index is refreshed.
    expect(repo.git(['diff-files', '--name-only'])).toBe('a.txt')
    expect(await refreshIndexStat(repo.dir)).toBe(true)
    expect(repo.git(['diff-files', '--name-only'])).toBe('')
    expect(repo.git(['diff', '--cached', '--name-only'])).toBe('b.txt')
  })

  it('detects and writes the commit-graph', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n' })
    expect(await hasCommitGraph(repo.dir)).toBe(false)
    await writeCommitGraph(repo.dir)
    expect(await hasCommitGraph(repo.dir)).toBe(true)
  })

  it('RepoHealth suggests a commit-graph only after a slow first page without one', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n' })
    const health = new RepoHealth()
    await health.timeFirstPage(repo.dir, 0, async () => 'fast')
    expect(await health.suggestCommitGraph(repo.dir)).toBe(false)
    const slow = new RepoHealth()
    await slow.timeFirstPage(repo.dir, 2000, () => new Promise((r) => setTimeout(r, 450)))
    expect(await slow.suggestCommitGraph(repo.dir)).toBe(false) // not the first page
    await slow.timeFirstPage(repo.dir, 0, () => new Promise((r) => setTimeout(r, 450)))
    expect(await slow.suggestCommitGraph(repo.dir)).toBe(true)
    await writeCommitGraph(repo.dir)
    expect(await slow.suggestCommitGraph(repo.dir)).toBe(false)
  })
})

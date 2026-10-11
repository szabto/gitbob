/**
 * Benchmark of the git-core calls behind each screen, on a real repository you already have.
 *
 * Not part of the default test run (skipped unless GITBOB_BENCH_REPO is set):
 *
 *   GITBOB_BENCH_REPO=/path/to/clone npx vitest run tests/bench/real-repo.bench.test.ts
 *
 * Optional: GITBOB_BENCH_OUT=results.json writes the raw numbers. The repository is only read
 * (log, refs, status, details, diff, blame, search); nothing is written to it.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getBlame } from '@git-core/blame'
import { getCommitDetails } from '@git-core/details'
import { getFileDiff } from '@git-core/diff'
import { getCommitPage } from '@git-core/log'
import { getHead, listRefs } from '@git-core/refs'
import { searchCommits } from '@git-core/search'
import { getStatus } from '@git-core/status'
import { GraphLayoutBuilder } from '@git-graph/layout'
import type { CommitSummary } from '@shared/types'

const REPO = process.env.GITBOB_BENCH_REPO ?? ''
const PAGE_SIZE = 2000
const results: Record<string, number | string> = {}

const ms = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10
async function time<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  const r = await fn()
  results[name] = ms(t0)
  return r
}
async function median(name: string, runs: number, fn: () => Promise<unknown>): Promise<void> {
  const t: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    t.push(performance.now() - t0)
  }
  t.sort((a, b) => a - b)
  results[name] = Math.round(t[Math.floor(t.length / 2)]! * 10) / 10
}
const git = (args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 30 }).trim()

describe.skipIf(!REPO)('real repository benchmark', () => {
  it('measures every screen', { timeout: 1_800_000 }, async () => {
    results.repo = REPO
    results.git = git(['--version'])
    results.commits = Number(git(['rev-list', '--count', '--all']))
    results.refs = git(['for-each-ref', '--format=x']).split('\n').length
    results.trackedFiles = git(['ls-files']).split('\n').length
    results.commitGraph = git(['rev-parse', '--git-path', 'objects/info/commit-graph'])

    // Opening: refs + head + first page + layout of the first page.
    await median('listRefs (median of 5)', 5, () => listRefs(REPO))
    await median('getHead (median of 5)', 5, () => getHead(REPO))
    const first = await time('first page (2k), cold', () => getCommitPage(REPO, { skip: 0, limit: PAGE_SIZE }))
    await median('first page (2k), warm (median of 3)', 3, () => getCommitPage(REPO, { skip: 0, limit: PAGE_SIZE }))

    // Scrolling to the end: every page, appended to one incremental layout like the renderer does.
    const builder = new GraphLayoutBuilder()
    const all: CommitSummary[] = [...first.commits]
    builder.append(first.commits)
    let layoutMs = 0
    const t0 = performance.now()
    let page = first
    while (page.hasMore) {
      page = await getCommitPage(REPO, { skip: all.length, limit: PAGE_SIZE })
      all.push(...page.commits)
      const l0 = performance.now()
      builder.append(page.commits)
      layoutMs += performance.now() - l0
    }
    results['all pages (history to the end)'] = ms(t0)
    results['incremental layout total'] = Math.round(layoutMs * 10) / 10
    results['graph width (lanes)'] = builder.result().width
    results['commits loaded'] = all.length
    expect(all.length).toBe(Number(git(['rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD'])))

    // Working changes and search.
    await median('getStatus, clean tree (median of 5)', 5, () => getStatus(REPO))
    await median('search "fix" (median of 3)', 3, () => searchCommits(REPO, 'fix'))
    await median('search by commit id prefix (median of 3)', 3, () => searchCommits(REPO, all[Math.floor(all.length / 2)]!.sha.slice(0, 8)))

    // Commit details and diffs of the 20 biggest recent non-merge commits by changed files.
    const sample = all.filter((c) => c.parents.length === 1).slice(0, 400)
    const sized = sample.map((c) => ({ c, n: git(['diff-tree', '--no-commit-id', '--name-only', '-r', c.sha]).split('\n').length }))
    sized.sort((a, b) => b.n - a.n)
    const big = sized.slice(0, 20)
    results['largest sampled commit (files)'] = big[0]!.n
    const detailTimes: number[] = []
    const diffTimes: number[] = []
    for (const { c } of big) {
      let t = performance.now()
      const d = await getCommitDetails(REPO, c.sha)
      detailTimes.push(performance.now() - t)
      const f = d.files[0]
      if (f) {
        t = performance.now()
        await getFileDiff(REPO, { kind: 'commit', sha: c.sha, path: f.path })
        diffTimes.push(performance.now() - t)
      }
    }
    const med = (xs: number[]): number => Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! * 10) / 10
    const max = (xs: number[]): number => Math.round(Math.max(...xs) * 10) / 10
    results['commit details, 20 large commits (median / max)'] = `${med(detailTimes)} / ${max(detailTimes)}`
    results['file diff in those commits (median / max)'] = `${med(diffTimes)} / ${max(diffTimes)}`

    // Blame of the most-changed file among the sampled commits.
    const counts = new Map<string, number>()
    for (const p of git(['log', '--format=', '--name-only', '-n', '3000', 'HEAD']).split('\n').filter(Boolean)) counts.set(p, (counts.get(p) ?? 0) + 1)
    const hot = [...counts.entries()].filter(([p]) => {
      try {
        git(['cat-file', '-e', `HEAD:${p}`])
        return true
      } catch {
        return false
      }
    }).sort((a, b) => b[1] - a[1])[0]![0]
    results['blame file'] = `${hot} (${git(['show', `HEAD:${hot}`]).split('\n').length} lines)`
    await time('blame of that file', () => getBlame(REPO, hot))

    console.table(results)
    if (process.env.GITBOB_BENCH_OUT) writeFileSync(process.env.GITBOB_BENCH_OUT, JSON.stringify(results, null, 2))
  })
})

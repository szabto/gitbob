/**
 * History loading + graph layout benchmark on a large synthetic repository.
 *
 * Not part of the default test run (skipped unless GITBOB_BENCH is set):
 *
 *   GITBOB_BENCH=1 npx vitest run tests/bench
 *
 * Optional environment:
 *   GITBOB_BENCH_COMMITS  commits to generate (default 100000)
 *   GITBOB_BENCH_OUT      write the raw results as JSON to this file
 *
 * The repository is generated with scripts/bench/make-large-repo.mjs into a
 * fresh temp directory and deleted afterwards. Every scenario is measured
 * twice: without a commit-graph file (fast-import output, like a fresh
 * clone without maintenance) and after `git commit-graph write --reachable`
 * (what `git gc`/`git maintenance` produce in most long-lived clones).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getCommitPage, LOG_FORMAT, parseLog } from '@git-core/log'
import { listRefs } from '@git-core/refs'
import { runGit } from '@git-core/runner'
import { computeGraphLayout, GraphLayoutBuilder } from '@git-graph/layout'
import type { CommitSummary } from '@shared/types'

const ENABLED = Boolean(process.env.GITBOB_BENCH)
const COMMITS = Number(process.env.GITBOB_BENCH_COMMITS ?? 100_000)
/** Page size used by the renderer (src/renderer/src/lib/queries.ts). */
const PAGE_SIZE = 2000

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

const results: Record<string, unknown> = {}
let root = ''
let repo = ''

function ms(t0: number): number {
  return Math.round((performance.now() - t0) * 10) / 10
}

async function median(runs: number, fn: () => Promise<unknown> | unknown): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return Math.round(times[Math.floor(times.length / 2)]! * 10) / 10
}

const REVS = ['--branches', '--remotes', '--tags', 'HEAD']

/** The pre-M4 implementation: one `git log --skip=N --max-count` per page. */
async function legacyPage(skip: number, limit: number): Promise<{ commits: CommitSummary[]; hasMore: boolean }> {
  const { stdout } = await runGit(
    ['log', '-z', '--date-order', `--format=${LOG_FORMAT}`, `--skip=${skip}`, `--max-count=${limit + 1}`, ...REVS, '--'],
    { cwd: repo, timeoutMs: 120_000 },
  )
  const commits = parseLog(stdout)
  const hasMore = commits.length > limit
  if (hasMore) commits.length = limit
  return { commits, hasMore }
}

type Pager = (skip: number, limit: number) => Promise<{ commits: CommitSummary[]; hasMore: boolean }>

/** Load every page sequentially, exactly like the renderer's infinite query. */
async function loadAll(pager: Pager): Promise<{ commits: CommitSummary[]; pages: number[]; totalMs: number }> {
  const commits: CommitSummary[] = []
  const pages: number[] = []
  const t0 = performance.now()
  let hasMore = true
  while (hasMore) {
    const tp = performance.now()
    const page = await pager(commits.length, PAGE_SIZE)
    pages.push(ms(tp))
    commits.push(...page.commits)
    hasMore = page.hasMore
  }
  return { commits, pages, totalMs: ms(t0) }
}

async function fullLogStdout(): Promise<string> {
  const { stdout } = await runGit(['log', '-z', '--date-order', `--format=${LOG_FORMAT}`, ...REVS, '--'], {
    cwd: repo,
    timeoutMs: 120_000,
  })
  return stdout
}

async function measureHistory(variant: string): Promise<CommitSummary[]> {
  const r: Record<string, unknown> = {}
  results[variant] = r

  const stdout = await fullLogStdout()
  r.fullLogSingleRunMs = await median(3, fullLogStdout)
  r.parseLogFullMs = await median(3, () => parseLog(stdout))
  gc()
  const heapBefore = process.memoryUsage().heapUsed
  const reference = parseLog(stdout)
  gc()
  r.parsedCommitsRetainedHeapMB = Math.round(((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024) * 10) / 10
  r.commits = reference.length

  r.legacyFirstPageMs = await median(5, () => legacyPage(0, PAGE_SIZE))
  r.legacyLastPageMs = await median(3, () => legacyPage(reference.length - PAGE_SIZE, PAGE_SIZE))
  const legacy = await loadAll(legacyPage)
  expect(legacy.commits.map((c) => c.sha)).toEqual(reference.map((c) => c.sha))
  r.legacyAllPagesMs = legacy.totalMs
  r.legacyPages = legacy.pages.length
  r.legacyPageMsFirst5 = legacy.pages.slice(0, 5)
  r.legacyPageMsLast5 = legacy.pages.slice(-5)

  const current: Pager = (skip, limit) => getCommitPage(repo, { skip, limit })
  r.firstPageMs = await median(5, () => current(0, PAGE_SIZE))
  const all = await loadAll(current)
  expect(all.commits.map((c) => c.sha)).toEqual(reference.map((c) => c.sha))
  expect(all.commits).toEqual(reference)
  r.allPagesMs = all.totalMs
  r.pageMsFirst5 = all.pages.slice(0, 5)
  r.pageMsLast5 = all.pages.slice(-5)
  r.pageMsMax = Math.max(...all.pages)
  // A second full pass (e.g. after the renderer refetches) with nothing changed.
  r.allPagesWarmMs = (await loadAll(current)).totalMs

  r.listRefsMs = await median(5, () => listRefs(repo))
  r.refCount = (await listRefs(repo)).length
  return reference
}

describe.skipIf(!ENABLED)('history benchmark', () => {
  let commits: CommitSummary[] = []

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'gitbob-bench-')))
    repo = join(root, 'repo')
    const script = resolve(__dirname, '../../scripts/bench/make-large-repo.mjs')
    const t0 = performance.now()
    const out = execFileSync(process.execPath, [script, String(COMMITS), repo], { encoding: 'utf8' })
    results.generator = { ...JSON.parse(out), wallMs: ms(t0) }
    console.log(out)
  }, 300_000)

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    console.log(JSON.stringify(results, null, 2))
    if (process.env.GITBOB_BENCH_OUT) writeFileSync(process.env.GITBOB_BENCH_OUT, JSON.stringify(results, null, 2))
  })

  it('history loading without a commit-graph', async () => {
    commits = await measureHistory('noCommitGraph')
  }, 600_000)

  it('history loading with a commit-graph', async () => {
    execFileSync('git', ['commit-graph', 'write', '--reachable'], { cwd: repo })
    await measureHistory('commitGraph')
  }, 600_000)

  it('graph layout', async () => {
    const r: Record<string, unknown> = {}
    results.layout = r
    if (commits.length === 0) commits = parseLog(await fullLogStdout())
    for (const n of [2_000, 20_000, 100_000]) {
      const slice = commits.slice(0, n)
      const runs = n >= 100_000 ? 3 : 5
      r[`layout${n}Ms`] = await median(runs, () => computeGraphLayout(slice))
      r[`layout${n}Width`] = computeGraphLayout(slice).width
      r[`layout${n}Rows`] = slice.length
    }
    // What CommitGraph.tsx currently does: recompute the whole layout after every page.
    const t0 = performance.now()
    for (let n = PAGE_SIZE; n < commits.length + PAGE_SIZE; n += PAGE_SIZE) computeGraphLayout(commits.slice(0, n))
    r.recomputeAfterEveryPageMs = ms(t0)
    r.incrementalAllPagesMs = await median(3, () => {
      const b = new GraphLayoutBuilder()
      for (let i = 0; i < commits.length; i += PAGE_SIZE) b.append(commits.slice(i, i + PAGE_SIZE))
      return b.result()
    })

    // Retained heap of a full layout (rows + segments) for all commits.
    gc()
    gc()
    const before = process.memoryUsage().heapUsed
    const layout = computeGraphLayout(commits)
    gc()
    gc()
    const after = process.memoryUsage().heapUsed
    r.layoutAllRetainedHeapMB = Math.round(((after - before) / 1024 / 1024) * 10) / 10
    r.layoutAllRows = layout.rows.length
    r.layoutAllSegments = layout.rows.reduce((n, row) => n + row.incoming.length + row.outgoing.length + row.passThrough.length, 0)
    expect(layout.rows).toHaveLength(commits.length)
  }, 600_000)
})

import { hasCommitGraph, refreshIndexStat } from '@git-core/maintenance'

/** Tests can lower the thresholds below (GITBOB_TEST_SLOW_MS=0 treats every call as slow). */
const testThreshold = process.env.GITBOB_TEST_SLOW_MS !== undefined ? Number(process.env.GITBOB_TEST_SLOW_MS) : NaN
/** Status slower than this suggests stale index stat data. */
const SLOW_STATUS_MS = Number.isFinite(testThreshold) ? testThreshold : 400
/** First history page slower than this, without a commit-graph, makes the speed-up worth offering. */
const SLOW_FIRST_PAGE_MS = Number.isFinite(testThreshold) ? testThreshold : 400
const REFRESH_INTERVAL_MS = 60_000

/**
 * Watches the cost of status and history calls per repository and keeps them fast:
 * refreshes stale index stat data in the background, and notes when a commit-graph would help.
 */
export class RepoHealth {
  private lastRefresh = new Map<string, number>()
  private refreshing = new Set<string>()
  private slowHistory = new Map<string, boolean>()

  async timeStatus<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now()
    const r = await fn()
    if (Date.now() - t0 >= SLOW_STATUS_MS) this.scheduleRefresh(repoPath)
    return r
  }

  async timeFirstPage<T>(repoPath: string, skip: number, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now()
    const r = await fn()
    if (skip === 0 && !this.slowHistory.has(repoPath) && Date.now() - t0 >= SLOW_FIRST_PAGE_MS) {
      this.slowHistory.set(repoPath, !(await hasCommitGraph(repoPath).catch(() => true)))
    }
    return r
  }

  /** Whether to offer writing a commit-graph (slow history and none present). */
  async suggestCommitGraph(repoPath: string): Promise<boolean> {
    if (!this.slowHistory.get(repoPath)) return false
    return !(await hasCommitGraph(repoPath))
  }

  commitGraphWritten(repoPath: string): void {
    this.slowHistory.set(repoPath, false)
  }

  private scheduleRefresh(repoPath: string): void {
    const last = this.lastRefresh.get(repoPath) ?? 0
    if (this.refreshing.has(repoPath) || Date.now() - last < REFRESH_INTERVAL_MS) return
    this.refreshing.add(repoPath)
    this.lastRefresh.set(repoPath, Date.now())
    void refreshIndexStat(repoPath).finally(() => this.refreshing.delete(repoPath))
  }
}

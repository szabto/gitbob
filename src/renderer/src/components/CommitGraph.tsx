import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { CommitSummary, GitRef } from '@shared/types'
import { computeGraphLayout } from '@git-graph/layout'
import { useAppStore } from '../state/store'
import { formatShortDate, shortSha } from '../lib/format'
import { GraphCell, LANE_WIDTH, ROW_HEIGHT } from './GraphCell'
import { RefBadge } from './RefBadge'
import { GraphSearch } from './GraphSearch'

interface Props {
  repoPath: string
  commits: CommitSummary[]
  refsBySha: Map<string, GitRef[]>
  headSha: string | null
  currentRef: string | null
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  /** Working tree change counts, or null when the repository has no work tree. */
  wip: { unstaged: number; staged: number } | null
  onRowMenu?: (e: React.MouseEvent, commit: CommitSummary) => void
}

const MAX_GRAPH_LANES = 24

export function CommitGraph({
  repoPath,
  commits,
  refsBySha,
  headSha,
  currentRef,
  hasMore,
  loadingMore,
  onLoadMore,
  wip,
  onRowMenu,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null)
  const selectedSha = useAppStore((s) => s.selectedSha)
  const revealSha = useAppStore((s) => s.revealSha)
  const select = useAppStore((s) => s.select)
  const selectWip = useAppStore((s) => s.selectWip)
  const wipSelected = useAppStore((s) => s.wipSelected)
  const hasWip = !!wip && wip.unstaged + wip.staged > 0
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const clearReveal = useAppStore((s) => s.clearReveal)

  const layout = useMemo(() => computeGraphLayout(commits), [commits])
  const indexBySha = useMemo(() => new Map(commits.map((c, i) => [c.sha, i])), [commits])
  const graphLanes = Math.min(layout.width, MAX_GRAPH_LANES)
  const graphColumnWidth = Math.max(graphLanes * LANE_WIDTH + 12, 64)

  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  })
  const items = virtualizer.getVirtualItems()

  // Incrementally load more history when the viewport nears the end.
  const lastIndex = items[items.length - 1]?.index ?? 0
  useEffect(() => {
    if (hasMore && !loadingMore && lastIndex >= commits.length - 50) onLoadMore()
  }, [hasMore, loadingMore, lastIndex, commits.length, onLoadMore])

  useEffect(() => {
    if (!revealSha) return
    const idx = indexBySha.get(revealSha)
    if (idx !== undefined) {
      virtualizer.scrollToIndex(idx, { align: 'center' })
      clearReveal()
    } else if (hasMore && !loadingMore) {
      onLoadMore()
    } else if (!hasMore) {
      clearReveal()
    }
  }, [revealSha, indexBySha, virtualizer, clearReveal, hasMore, loadingMore, onLoadMore])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const cur = selectedSha ? (indexBySha.get(selectedSha) ?? -1) : -1
      const next = Math.max(0, Math.min(commits.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))
      const sha = commits[next]?.sha
      if (sha) {
        select(sha)
        virtualizer.scrollToIndex(next, { align: 'auto' })
      }
    },
    [selectedSha, indexBySha, commits, select, virtualizer],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center border-b border-border bg-panel text-xs font-semibold text-muted">
        <div style={{ width: graphColumnWidth }} className="shrink-0 pl-3">
          Graph
        </div>
        <div className="flex flex-1 items-center px-2">
          Message
          <GraphSearch repoPath={repoPath} onMatchesChange={setMatches} />
        </div>
        <div className="w-40 shrink-0 px-2">Author</div>
        <div className="w-28 shrink-0 px-2">Date</div>
        <div className="w-20 shrink-0 px-2">SHA</div>
      </div>
      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-auto outline-none"
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="commit-graph"
        role="listbox"
        aria-label="Commit history"
      >
        {hasWip && (
          <div
            role="option"
            aria-selected={wipSelected}
            data-testid="wip-row"
            onClick={selectWip}
            className={`sticky top-0 z-10 flex cursor-default items-center border-b border-dashed border-border ${
              wipSelected ? 'bg-accent/25' : 'bg-bg hover:bg-panel'
            }`}
            style={{ height: ROW_HEIGHT }}
          >
            <div className="flex shrink-0 justify-center" style={{ width: graphColumnWidth }}>
              <svg width={16} height={16} aria-hidden>
                <circle cx={8} cy={8} r={6} fill="none" stroke="#b46cff" strokeWidth={2} strokeDasharray="3 2" />
              </svg>
            </div>
            <div className="flex flex-1 items-center gap-2 px-2">
              <span className="font-mono text-xs text-muted">// WIP</span>
              <span>Working changes</span>
              {wip.unstaged > 0 && (
                <span className="rounded bg-amber-500/15 px-1.5 text-xs text-amber-200">{wip.unstaged} unstaged</span>
              )}
              {wip.staged > 0 && (
                <span className="rounded bg-emerald-500/15 px-1.5 text-xs text-emerald-200">{wip.staged} staged</span>
              )}
            </div>
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const commit = commits[item.index]!
            const row = layout.rows[item.index]!
            const refs = refsBySha.get(commit.sha)
            const selected = commit.sha === selectedSha
            const dimmed = matches !== null && !matches.has(commit.sha)
            return (
              <div
                key={commit.sha}
                role="option"
                aria-selected={selected}
                data-testid="commit-row"
                data-sha={commit.sha}
                onClick={() => select(commit.sha)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  select(commit.sha)
                  onRowMenu?.(e, commit)
                }}
                data-match={matches?.has(commit.sha) ? 'true' : undefined}
                className={`absolute left-0 flex w-full cursor-default items-center ${
                  selected ? 'bg-accent/20' : 'hover:bg-white/[0.03]'
                } ${dimmed ? 'opacity-35' : ''}`}
                style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                <div className="shrink-0 overflow-hidden pl-3" style={{ width: graphColumnWidth }}>
                  <GraphCell row={row} width={layout.width} isHead={commit.sha === headSha} />
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
                  {refs?.map((r) => (
                    <RefBadge key={r.name} gitRef={r} current={r.name === currentRef} />
                  ))}
                  <span className="truncate" data-testid="commit-subject">
                    {commit.subject}
                  </span>
                </div>
                <div className="w-40 shrink-0 truncate px-2 text-muted" title={commit.authorEmail}>
                  {commit.authorName}
                </div>
                <div className="w-28 shrink-0 truncate px-2 text-muted">{formatShortDate(commit.authorTime)}</div>
                <div className="w-20 shrink-0 px-2 font-mono text-xs text-muted">{shortSha(commit.sha)}</div>
              </div>
            )
          })}
        </div>
        {loadingMore && <div className="p-2 text-center text-xs text-muted">Loading more…</div>}
      </div>
      <div className="flex h-6 shrink-0 items-center border-t border-border bg-panel px-3 text-xs text-muted">
        <span data-testid="commit-count">
          {commits.length} commit{commits.length === 1 ? '' : 's'}
          {hasMore ? '+' : ''}
        </span>
      </div>
    </div>
  )
}

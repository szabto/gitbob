import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { CommitSummary, GitRef } from '@shared/types'
import { useGraphLayout } from '../lib/useGraphLayout'
import { useAppStore } from '../state/store'
import { formatShortDate, shortSha } from '../lib/format'
import { GraphCell, LANE_WIDTH, ROW_HEIGHT } from './GraphCell'
import { RefLabelPill } from './RefLabelPill'
import { ResizeHandle } from './ResizeHandle'
import { buildRefLabels, type RefLabel } from '../lib/ref-labels'
import { clampWidth, useGraphColumns, type GraphColumns } from '../lib/graph-columns'
import { initials, nameHue, useAvatarSource, useEmailAvatar, type AvatarSource } from '../lib/avatars'
import { useCommitCount, useRemotes } from '../lib/queries'
import { useUiStore } from '../state/ui'
import type { GraphRow } from '@git-graph/layout'
import type { RemoteInfo } from '@shared/types'
import { endDrag, startDrag } from '../lib/dnd'
import { GraphSearch } from './GraphSearch'
import { GraphFilter } from './GraphFilter'

interface Props {
  repoPath: string
  commits: CommitSummary[]
  headSha: string | null
  currentRef: string | null
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  /** Working tree change counts, or null when the repository has no work tree. */
  wip: { unstaged: number; staged: number; modified?: number; added?: number; deleted?: number } | null
  onRowMenu?: (e: React.MouseEvent, commit: CommitSummary) => void
  /** Right-click on a branch / tag label. */
  onRefMenu?: (e: React.MouseEvent, ref: GitRef) => void
  /** All refs, for the filter's branch picker. */
  refs: GitRef[]
}

const MAX_GRAPH_LANES = 24

export function CommitGraph({
  repoPath,
  commits,
  headSha,
  currentRef,
  hasMore,
  loadingMore,
  onLoadMore,
  wip,
  onRowMenu,
  onRefMenu,
  refs: allRefs,
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

  const layout = useGraphLayout(commits)
  const [cols, setCols] = useGraphColumns()
  const resizeStart = useRef<GraphColumns>(cols)
  const remotes = useRemotes(repoPath)
  const avatarSource = useAvatarSource(repoPath)
  const labelsBySha = useMemo(() => buildRefLabels(allRefs, currentRef), [allRefs, currentRef])
  const openMenu = useUiStore((s) => s.openMenu)
  const historyFilter = useAppStore((s) => s.historyFilter)
  const total = useCommitCount(repoPath, hasMore && !historyFilter)
  const resizer = (key: 'refs' | 'author' | 'date' | 'sha', sign: 1 | -1) => ({
    onStart: () => {
      resizeStart.current = cols
    },
    onResize: (dx: number) => setCols((c) => ({ ...c, [key]: clampWidth(resizeStart.current[key] + sign * dx) })),
  })
  const columnMenu = (e: React.MouseEvent): void => {
    const toggle = (k: keyof GraphColumns['show'], label: string) => ({
      label: `${cols.show[k] ? '✓ ' : '\u2003'}${label}`,
      onSelect: () => setCols((c) => ({ ...c, show: { ...c.show, [k]: !c.show[k] } })),
    })
    openMenu(e.clientX, e.clientY, [toggle('refs', 'Branch / Tag'), toggle('author', 'Author'), toggle('date', 'Date'), toggle('sha', 'SHA'), 'separator', { label: 'Reset columns', onSelect: () => setCols(() => ({ refs: 180, author: 150, date: 110, sha: 80, show: { refs: true, author: true, date: true, sha: true } })) }])
  }
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
      <div className="flex h-7 shrink-0 items-center border-b border-border bg-panel text-xs font-semibold text-muted" data-testid="graph-header">
        {cols.show.refs && (
          <div style={{ width: cols.refs }} className="relative shrink-0 truncate pl-3">
            Branch / Tag
            <ResizeHandle edge="right" label="Resize Branch / Tag column" {...resizer('refs', 1)} />
          </div>
        )}
        <div style={{ width: graphColumnWidth }} className="shrink-0 pl-3">
          Graph
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <span className="shrink-0">Message</span>
          <GraphFilter refs={allRefs} />
          <GraphSearch repoPath={repoPath} onMatchesChange={setMatches} />
        </div>
        {cols.show.author && (
          <div style={{ width: cols.author }} className="relative shrink-0 px-2">
            <ResizeHandle edge="left" label="Resize Author column" {...resizer('author', -1)} />
            Author
          </div>
        )}
        {cols.show.date && (
          <div style={{ width: cols.date }} className="relative shrink-0 px-2">
            <ResizeHandle edge="left" label="Resize Date column" {...resizer('date', -1)} />
            Date
          </div>
        )}
        {cols.show.sha && (
          <div style={{ width: cols.sha }} className="relative shrink-0 px-2">
            <ResizeHandle edge="left" label="Resize SHA column" {...resizer('sha', -1)} />
            SHA
          </div>
        )}
        <button className="shrink-0 px-2 hover:text-fg" aria-label="Choose columns" title="Choose columns" onClick={columnMenu}>
          ⚙
        </button>
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
            {cols.show.refs && <div className="shrink-0" style={{ width: cols.refs }} />}
            <div className="flex shrink-0 justify-center" style={{ width: graphColumnWidth }}>
              <svg width={16} height={16} aria-hidden>
                <circle cx={8} cy={8} r={6} fill="none" stroke="#b46cff" strokeWidth={2} strokeDasharray="3 2" />
              </svg>
            </div>
            <div className="flex flex-1 items-center gap-2 px-2">
              <span className="font-mono text-xs text-muted">// WIP</span>
              <span>Working changes</span>
              {wip.unstaged > 0 && (
                <span className="rounded bg-warn/15 px-1.5 text-xs text-warn">{wip.unstaged} unstaged</span>
              )}
              {wip.staged > 0 && (
                <span className="rounded bg-ok/15 px-1.5 text-xs text-ok">{wip.staged} staged</span>
              )}
              <span className="flex gap-2 text-xs text-muted" data-testid="wip-kinds">
                {!!wip.modified && <span title="Modified">✎ {wip.modified}</span>}
                {!!wip.added && <span title="New" className="text-ok">+ {wip.added}</span>}
                {!!wip.deleted && <span title="Deleted" className="text-err">− {wip.deleted}</span>}
              </span>
            </div>
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const commit = commits[item.index]!
            const row = layout.rows[item.index]!
            const selected = commit.sha === selectedSha
            const dimmed = matches !== null && !matches.has(commit.sha)
            return (
              <div
                key={commit.sha}
                role="option"
                aria-selected={selected}
                data-testid="commit-row"
                data-sha={commit.sha}
                draggable
                onDragStart={(e) => startDrag(e, { kind: 'commit', sha: commit.sha, subject: commit.subject })}
                onDragEnd={endDrag}
                onClick={() => select(commit.sha)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  select(commit.sha)
                  onRowMenu?.(e, commit)
                }}
                data-match={matches?.has(commit.sha) ? 'true' : undefined}
                className={`absolute left-0 flex w-full cursor-default items-center ${
                  selected ? 'bg-accent/20' : 'hover:bg-fg/[0.03]'
                } ${dimmed ? 'opacity-35' : ''}`}
                style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                <CommitRowCells
                  commit={commit}
                  row={row}
                  width={layout.width}
                  graphColumnWidth={graphColumnWidth}
                  isHead={commit.sha === headSha}
                  labels={labelsBySha.get(commit.sha)}
                  remotes={remotes.data ?? []}
                  cols={cols}
                  avatarSource={avatarSource}
                  onRefMenu={onRefMenu}
                />
              </div>
            )
          })}
        </div>
        {loadingMore && <div className="p-2 text-center text-xs text-muted">Loading more…</div>}
      </div>
      <div className="flex h-6 shrink-0 items-center border-t border-border bg-panel px-3 text-xs text-muted">
        <span data-testid="commit-count">
          {hasMore && total.data ? `${commits.length.toLocaleString('en-US')} of ${total.data.toLocaleString('en-US')} commits` : `${commits.length} commit${commits.length === 1 ? '' : 's'}${hasMore ? '+' : ''}`}
        </span>
      </div>
    </div>
  )
}

/** The cells of one commit row; a component of its own so it can load the author's avatar. */
function CommitRowCells({
  commit,
  row,
  width,
  graphColumnWidth,
  isHead,
  labels,
  remotes,
  cols,
  avatarSource,
  onRefMenu,
}: {
  onRefMenu?: (e: React.MouseEvent, ref: GitRef) => void
  commit: CommitSummary
  row: GraphRow
  width: number
  graphColumnWidth: number
  isHead: boolean
  labels: RefLabel[] | undefined
  remotes: RemoteInfo[]
  cols: GraphColumns
  avatarSource: AvatarSource
}) {
  const src = useEmailAvatar(commit.authorEmail, avatarSource)
  const avatar = row.isMerge ? undefined : { src, initials: initials(commit.authorName), hue: nameHue(commit.authorName) }
  const shown = labels?.slice(0, 2) ?? []
  const more = (labels?.length ?? 0) - shown.length
  return (
    <>
      {cols.show.refs && (
        <div className="flex shrink-0 items-center gap-1 overflow-hidden pl-2" style={{ width: cols.refs }} data-testid="refs-cell">
          {shown.map((l) => (
            <RefLabelPill key={l.key} label={l} remotes={remotes} {...(onRefMenu ? { onMenu: (e: React.MouseEvent) => onRefMenu(e, l.primary) } : {})} />
          ))}
          {more > 0 && (
            <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted" title={labels!.slice(2).map((l) => l.name).join('\n')}>
              +{more}
            </span>
          )}
        </div>
      )}
      <div className="shrink-0 overflow-hidden pl-3" style={{ width: graphColumnWidth }}>
        <GraphCell row={row} width={width} isHead={isHead} avatar={avatar} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
        {!cols.show.refs && labels?.map((l) => <RefLabelPill key={l.key} label={l} remotes={remotes} />)}
        <span className="truncate" data-testid="commit-subject" title={commit.subject}>
          {commit.subject}
        </span>
      </div>
      {cols.show.author && (
        <div className="shrink-0 truncate px-2 text-muted" style={{ width: cols.author }} title={`${commit.authorName} <${commit.authorEmail}>`}>
          {commit.authorName}
        </div>
      )}
      {cols.show.date && (
        <div className="shrink-0 truncate px-2 text-muted" style={{ width: cols.date }}>
          {formatShortDate(commit.authorTime)}
        </div>
      )}
      {cols.show.sha && (
        <div className="shrink-0 px-2 font-mono text-xs text-muted" style={{ width: cols.sha }}>
          {shortSha(commit.sha)}
        </div>
      )}
    </>
  )
}

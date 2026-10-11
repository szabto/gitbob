import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { FileHistoryEntry } from '@shared/types'
import { call } from '../lib/api'
import { formatShortDate, shortSha } from '../lib/format'
import { useAppStore } from '../state/store'
import { DiffView } from './DiffView'

const STATUS_LABEL: Record<FileHistoryEntry['status'], string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged',
  X: 'Changed',
}

/** Every commit that changed a file (following renames), with that commit's diff of it. */
export function FileHistoryView({ repoPath, path }: { repoPath: string; path: string }) {
  const openFileHistory = useAppStore((s) => s.openFileHistory)
  const reveal = useAppStore((s) => s.reveal)
  const history = useInfiniteQuery({
    queryKey: ['file-history', repoPath, path],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => call('file:history', { repoPath, path, skip: pageParam }),
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.entries.length, 0) : undefined),
  })
  const entries = history.data?.pages.flatMap((p) => p.entries) ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const current = entries.find((e) => e.commit.sha === selected) ?? entries[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-history">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">File history</span>
        <span className="truncate font-mono text-xs">{path}</span>
        {history.data && (
          <span className="text-xs text-muted" data-testid="file-history-count">
            {entries.length}
            {history.hasNextPage ? '+' : ''} commit{entries.length === 1 ? '' : 's'}
          </span>
        )}
        <button className="ml-auto rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2" onClick={() => openFileHistory(null)}>
          Close
        </button>
      </div>
      {history.isPending ? (
        <div className="p-4 text-xs text-muted">Loading…</div>
      ) : history.isError ? (
        <div className="p-4 text-danger">{history.error.message}</div>
      ) : entries.length === 0 ? (
        <div className="p-4 text-sm text-muted">No commits changed this file.</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul
            role="listbox"
            aria-label="Commits that changed this file"
            className="w-80 shrink-0 overflow-y-auto border-r border-border text-sm"
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              e.preventDefault()
              const i = entries.findIndex((x) => x === current)
              const next = entries[Math.max(0, Math.min(entries.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
              if (next) setSelected(next.commit.sha)
            }}
            tabIndex={0}
          >
            {entries.map((e) => (
              <li
                key={e.commit.sha}
                role="option"
                aria-selected={e === current}
                data-testid="file-history-entry"
                data-sha={e.commit.sha}
                onClick={() => setSelected(e.commit.sha)}
                onDoubleClick={() => reveal(e.commit.sha)}
                title="Double-click to show this commit in the graph"
                className={`cursor-default border-b border-border px-3 py-1.5 ${e === current ? 'bg-accent/20' : 'hover:bg-panel'}`}
              >
                <div className="truncate">{e.commit.subject}</div>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="font-mono text-accent">{shortSha(e.commit.sha)}</span>
                  <span className="truncate">{e.commit.authorName}</span>
                  <span className="ml-auto shrink-0">{formatShortDate(e.commit.authorTime)}</span>
                </div>
                {e.status !== 'M' && (
                  <div className="text-xs text-muted">
                    {STATUS_LABEL[e.status]}
                    {e.oldPath ? ` from ${e.oldPath}` : ''}
                  </div>
                )}
              </li>
            ))}
            {history.hasNextPage && (
              <li className="p-2 text-center">
                <button
                  className="text-xs text-accent hover:underline disabled:opacity-40"
                  disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                >
                  {history.isFetchingNextPage ? 'Loading…' : 'Load older commits'}
                </button>
              </li>
            )}
          </ul>
          {current && current.status !== 'D' ? (
            <DiffView
              key={current.commit.sha}
              repoPath={repoPath}
              target={{ kind: 'commit', sha: current.commit.sha, path: current.path, ...(current.oldPath ? { oldPath: current.oldPath } : {}) }}
              onClose={() => openFileHistory(null)}
              showHistoryButton={false}
            />
          ) : current ? (
            <div className="flex-1 p-4 text-sm text-muted" data-testid="file-history-deleted">
              This commit deleted the file.
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

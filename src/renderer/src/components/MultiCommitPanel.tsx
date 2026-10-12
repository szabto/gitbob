import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CommitSummary } from '@shared/types'
import { ApiError, call } from '../lib/api'
import { useAppStore } from '../state/store'
import { shortSha } from '../lib/format'
import { CommitFiles } from './CommitFiles'

const LISTED = 30

/** Several selected commits: the list of them and every file they change, taken together. */
export function MultiCommitPanel({ repoPath, commits }: { repoPath: string; commits: CommitSummary[] }) {
  const select = useAppStore((s) => s.select)
  const [wholeRange, setWholeRange] = useState(false)
  const shas = commits.map((c) => c.sha)
  const combined = useQuery({
    queryKey: ['commits-combine', repoPath, shas, wholeRange],
    queryFn: () => call('commits:combine', { repoPath, shas, ...(wholeRange ? { wholeRange } : {}) }),
    staleTime: Infinity,
    retry: false,
  })
  const newest = commits[0]!
  const oldest = commits[commits.length - 1]!
  const detail = combined.error instanceof ApiError ? combined.error.detail : undefined

  return (
    <aside className="flex w-full min-w-0 flex-col border-l border-border bg-panel" data-testid="multi-commit">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-3 text-xs font-semibold text-muted">
        <span data-testid="multi-commit-count">{commits.length} commits selected</span>
        <button onClick={() => select(null)} aria-label="Clear selection" className="hover:text-fg">
          ✕
        </button>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-y-auto p-3">
        <ul className="text-xs" aria-label="Selected commits">
          {commits.slice(0, LISTED).map((c) => (
            <li key={c.sha} className="-mx-1 flex cursor-default gap-2 rounded px-1 py-0.5 hover:bg-fg/[0.05]" onClick={() => select(c.sha)} title="Show only this commit">
              <span className="shrink-0 font-mono text-muted">{shortSha(c.sha)}</span>
              <span className="min-w-0 truncate">{c.subject}</span>
            </li>
          ))}
          {commits.length > LISTED && <li className="py-0.5 text-muted">and {commits.length - LISTED} more</li>}
        </ul>

        <p className="mt-3 text-xs text-muted" data-testid="multi-commit-mode">
          {combined.data?.mode === 'combined' && 'Only the changes made in the selected commits; the commits between them are left out.'}
          {combined.data?.mode === 'contiguous' && 'All changes made in these commits.'}
          {combined.data?.mode === 'range' && (
            <>
              Everything from {shortSha(oldest.sha)}’s parent to {shortSha(newest.sha)}, including commits between them that aren’t selected.{' '}
              <button className="text-accent hover:underline" onClick={() => setWholeRange(false)}>
                Only the selected commits
              </button>
            </>
          )}
        </p>

        {combined.isPending ? (
          <div className="mt-3 text-xs text-muted">Combining changes…</div>
        ) : combined.isError ? (
          <div className="mt-3 rounded border border-border p-2 text-xs" data-testid="multi-commit-error">
            <p className="text-err">{combined.error.message}</p>
            {detail && <pre className="mt-1 font-mono whitespace-pre-wrap text-muted">{detail}</pre>}
            {!wholeRange && (
              <button className="mt-2 rounded border border-border px-2 py-0.5 hover:bg-panel-2" onClick={() => setWholeRange(true)}>
                Show the whole range instead
              </button>
            )}
          </div>
        ) : (
          <CommitFiles repoPath={repoPath} sha={combined.data.head} files={combined.data.files} range={{ base: combined.data.base, head: combined.data.head }} />
        )}
      </div>
    </aside>
  )
}

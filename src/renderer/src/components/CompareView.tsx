import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useAppStore } from '../state/store'
import { DiffView } from './DiffView'

const STATUS_CLS: Record<string, string> = { A: 'text-ok', M: 'text-warn', D: 'text-err', R: 'text-info', C: 'text-info', T: 'text-purple' }

/** Every file that differs between a commit and the working directory, with its diff. */
export function CompareView({ repoPath, sha }: { repoPath: string; sha: string }) {
  const openCompare = useAppStore((s) => s.openCompare)
  const files = useQuery({ queryKey: ['compare', repoPath, sha], queryFn: () => call('compare:files', { repoPath, sha }), staleTime: 0 })
  const [selected, setSelected] = useState<string | null>(null)
  const current = files.data?.find((f) => f.path === selected) ?? files.data?.[0]
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="compare-view">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">Compare</span>
        <span className="truncate text-xs">
          <span className="font-mono">{sha.slice(0, 7)}</span> ↔ working directory
        </span>
        {files.data && <span className="text-xs text-muted" data-testid="compare-count">{files.data.length} file{files.data.length === 1 ? '' : 's'} differ</span>}
        <button className="ml-auto rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2" onClick={() => openCompare(null)}>
          Close
        </button>
      </div>
      {files.isPending ? (
        <div className="p-4 text-xs text-muted">Loading…</div>
      ) : files.isError ? (
        <div className="p-4 text-err">{files.error.message}</div>
      ) : files.data.length === 0 ? (
        <div className="p-4 text-sm text-muted">The working directory matches this commit.</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-80 shrink-0 overflow-y-auto border-r border-border font-mono text-xs" aria-label="Files that differ">
            {files.data.map((f) => (
              <li
                key={f.path}
                data-testid="compare-file"
                data-path={f.path}
                onClick={() => setSelected(f.path)}
                className={`flex cursor-default items-center gap-2 px-3 py-1 ${f === current ? 'bg-accent/20' : 'hover:bg-panel'}`}
              >
                <span className={`w-3 shrink-0 font-bold ${STATUS_CLS[f.status] ?? 'text-muted'}`}>{f.status}</span>
                <span className="min-w-0 flex-1 truncate" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  {f.path}
                </span>
              </li>
            ))}
          </ul>
          {current && (
            <div className="flex min-w-0 flex-1">
              <DiffView
                key={current.path}
                repoPath={repoPath}
                target={{ kind: 'worktree-compare', sha, path: current.path, ...(current.oldPath ? { oldPath: current.oldPath } : {}) }}
                onClose={() => openCompare(null)}
                showHistoryButton={false}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

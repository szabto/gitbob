import type { StashEntry } from '@shared/types'
import { useStashFiles } from '../lib/queries'
import { useAppStore } from '../state/store'
import { formatDate } from '../lib/format'
import type { useRepoActions } from '../lib/actions'

const statusCls: Record<string, string> = { A: 'text-ok', M: 'text-warn', D: 'text-err', R: 'text-info' }

export function StashPanel({
  repoPath,
  stash,
  actions,
}: {
  repoPath: string
  stash: StashEntry
  actions: ReturnType<typeof useRepoActions>
}) {
  const files = useStashFiles(repoPath, stash)
  const selectStash = useAppStore((s) => s.selectStash)
  const showDiff = useAppStore((s) => s.showDiff)

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-panel" data-testid="stash-panel">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-3 text-xs font-semibold text-muted">
        <span>Stash {stash.ref}</span>
        <button onClick={() => selectStash(null)} aria-label="Close stash" className="hover:text-fg">
          ✕
        </button>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-y-auto p-3">
        <h2 className="text-[15px] font-semibold break-words" data-testid="stash-message">
          {stash.message}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {stash.branch ? `On ${stash.branch} · ` : ''}
          {formatDate(stash.time)}
        </p>
        <div className="mt-3 flex gap-2">
          <button
            className="rounded bg-gradient-to-r from-accent to-accent-2 px-3 py-1 font-medium text-on-accent"
            onClick={() => void actions.applyStash(stash, true).then(() => selectStash(null))}
          >
            Pop
          </button>
          <button
            className="rounded border border-border px-3 py-1 hover:bg-panel-2"
            onClick={() => void actions.applyStash(stash, false)}
          >
            Apply
          </button>
          <button
            className="ml-auto rounded border border-border px-3 py-1 text-err hover:bg-err/10"
            onClick={() => void actions.dropStash(stash)}
          >
            Delete…
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">Pop applies the changes and removes the stash; Apply keeps it.</p>

        <h3 className="mt-5 mb-1 text-xs font-semibold tracking-wider text-muted uppercase">
          {files.data ? `${files.data.length} file${files.data.length === 1 ? '' : 's'}` : 'Files'}
        </h3>
        {files.isError && <div className="text-xs text-err">{files.error.message}</div>}
        <ul className="font-mono text-xs" data-testid="stash-files">
          {files.data?.map((f) => (
            <li
              key={f.path}
              className="-mx-1 flex cursor-default items-center gap-2 rounded px-1 py-0.5 hover:bg-fg/[0.05]"
              onClick={() => showDiff({ kind: 'commit', sha: stash.sha, path: f.path })}
            >
              <span className={`w-3 shrink-0 font-bold ${statusCls[f.status] ?? 'text-muted'}`}>{f.status}</span>
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              {f.additions !== null && (
                <span className="shrink-0">
                  <span className="text-ok">+{f.additions}</span> <span className="text-err">-{f.deletions}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

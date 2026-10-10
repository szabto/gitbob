import { useQuery } from '@tanstack/react-query'
import { call } from '../lib/api'
import { formatShortDate, shortSha } from '../lib/format'
import { useAppStore } from '../state/store'

const UNCOMMITTED = '0000000000000000000000000000000000000000'

/** Line-by-line authorship of a file (working tree or a given commit). */
export function BlameView({ repoPath, path, rev }: { repoPath: string; path: string; rev?: string }) {
  const blame = useQuery({
    queryKey: ['blame', repoPath, path, rev ?? null],
    queryFn: () => call('blame:get', { repoPath, path, ...(rev ? { rev } : {}) }),
    staleTime: rev ? Infinity : 0,
  })
  const reveal = useAppStore((s) => s.reveal)
  const openBlame = useAppStore((s) => s.openBlame)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="blame-view">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">Blame{rev ? ` @ ${shortSha(rev)}` : ''}</span>
        <span className="truncate font-mono text-xs">{path}</span>
        <button className="ml-auto rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2" onClick={() => openBlame(null)}>
          Close
        </button>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto bg-bg font-mono text-xs leading-5">
        {blame.isPending ? (
          <div className="p-4 text-muted">Loading…</div>
        ) : blame.isError ? (
          <div className="p-4 text-danger">{blame.error.message}</div>
        ) : (
          <table className="w-full border-collapse" data-testid="blame-table">
            <tbody>
              {blame.data.lines.map((l, i) => {
                const first = i === 0 || blame.data.lines[i - 1]!.sha !== l.sha
                const uncommitted = l.sha === UNCOMMITTED
                return (
                  <tr key={l.line} className={first && i > 0 ? 'border-t border-border' : ''} data-testid="blame-line">
                    <td className="w-72 max-w-72 truncate border-r border-border px-2 align-top font-sans text-muted select-none">
                      {first &&
                        (uncommitted ? (
                          <span className="text-warn">Not committed yet</span>
                        ) : (
                          <button
                            className="flex w-full items-center gap-2 text-left hover:text-fg"
                            title={`${l.summary}\n${l.authorName}`}
                            onClick={() => reveal(l.sha)}
                          >
                            <span className="font-mono text-accent">{shortSha(l.sha)}</span>
                            <span className="truncate">{l.authorName}</span>
                            <span className="ml-auto shrink-0">{formatShortDate(l.authorTime)}</span>
                          </button>
                        ))}
                    </td>
                    <td className="w-12 border-r border-border px-2 text-right text-muted select-none">{l.line}</td>
                    <td className="px-2 whitespace-pre">{blame.data.text[i]}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

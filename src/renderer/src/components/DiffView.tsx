import type { DiffLine, DiffTarget } from '@shared/types'
import { useFileDiff } from '../lib/queries'
import { useAppStore } from '../state/store'

const targetLabel: Record<DiffTarget['kind'], string> = {
  unstaged: 'Unstaged changes',
  staged: 'Staged changes',
  untracked: 'New file',
  commit: 'Commit',
}

const lineCls: Record<DiffLine['type'], string> = {
  context: '',
  add: 'bg-emerald-500/12 text-emerald-100',
  del: 'bg-red-500/12 text-red-100',
  'no-newline': 'text-muted italic',
}

const prefix: Record<DiffLine['type'], string> = { context: ' ', add: '+', del: '-', 'no-newline': '\\' }

export function DiffView({ repoPath, target }: { repoPath: string; target: DiffTarget }) {
  const diff = useFileDiff(repoPath, target)
  const showDiff = useAppStore((s) => s.showDiff)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="diff-view">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">
          {targetLabel[target.kind]}
          {target.kind === 'commit' ? ` ${target.sha.slice(0, 7)}` : ''}
        </span>
        <span className="truncate font-mono text-xs" data-testid="diff-path">
          {diff.data?.oldPath ? `${diff.data.oldPath} → ` : ''}
          {target.path}
        </span>
        <button
          className="ml-auto rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2"
          onClick={() => showDiff(null)}
        >
          Close
        </button>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto bg-bg font-mono text-xs leading-5">
        {diff.isPending ? (
          <div className="p-4 text-muted">Loading diff…</div>
        ) : diff.isError ? (
          <div className="p-4 text-danger">{diff.error.message}</div>
        ) : diff.data.binary ? (
          <div className="p-4 text-muted" data-testid="diff-binary">
            Binary file — no text diff available.
          </div>
        ) : diff.data.hunks.length === 0 ? (
          <div className="p-4 text-muted" data-testid="diff-empty">
            No textual changes{diff.data.isNew ? ' (empty file)' : ''}.
          </div>
        ) : (
          <table className="w-full border-collapse" data-testid="diff-table">
            <tbody>
              {diff.data.hunks.map((h, hi) => (
                <HunkRows key={hi} header={h.header} lines={h.lines} />
              ))}
            </tbody>
          </table>
        )}
        {diff.data?.truncated && (
          <div className="p-3 text-center text-amber-300">Diff truncated: the file is too large to display fully.</div>
        )}
      </div>
    </div>
  )
}

function HunkRows({ header, lines }: { header: string; lines: DiffLine[] }) {
  return (
    <>
      <tr className="bg-sky-500/10 text-sky-300">
        <td colSpan={3} className="px-3 py-0.5">
          {header}
        </td>
      </tr>
      {lines.map((l, i) => (
        <tr key={i} className={lineCls[l.type]} data-line-type={l.type}>
          <td className="w-12 border-r border-border px-2 text-right text-muted select-none">{l.oldLine ?? ''}</td>
          <td className="w-12 border-r border-border px-2 text-right text-muted select-none">{l.newLine ?? ''}</td>
          <td className="px-2 whitespace-pre">
            <span className="select-none text-muted">{prefix[l.type]}</span>
            {l.content}
          </td>
        </tr>
      ))}
    </>
  )
}

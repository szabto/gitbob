import type { DiffLine, DiffTarget, FileDiff, HunkSelection } from '@shared/types'
import { Fragment, lazy, Suspense, useState } from 'react'
import { call } from '../lib/api'
import { useFileContents, useFileDiff, useRepoMutation } from '../lib/queries'
import { useUiStore } from '../state/ui'
import { useAppStore } from '../state/store'

const targetLabel: Record<DiffTarget['kind'], string> = {
  unstaged: 'Unstaged changes',
  staged: 'Staged changes',
  untracked: 'New file',
  commit: 'Commit',
}

const lineCls: Record<DiffLine['type'], string> = {
  context: '',
  add: 'bg-ok/12',
  del: 'bg-err/12',
  'no-newline': 'text-muted italic',
}

const prefix: Record<DiffLine['type'], string> = { context: ' ', add: '+', del: '-', 'no-newline': '\\' }

// Monaco is large; load it only when the side-by-side view is first used.
const SideBySideDiff = lazy(() => import('./SideBySideDiff').then((m) => ({ default: m.SideBySideDiff })))

export function DiffView({ repoPath, target }: { repoPath: string; target: DiffTarget }) {
  const diff = useFileDiff(repoPath, target)
  const showDiff = useAppStore((s) => s.showDiff)
  const mode = useUiStore((s) => s.diffMode)
  const setMode = useUiStore((s) => s.setDiffMode)
  const contents = useFileContents(repoPath, target, mode === 'split')

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
        <div className="ml-auto flex overflow-hidden rounded border border-border text-xs" role="group" aria-label="Diff layout">
          {(['unified', 'split'] as const).map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 ${mode === m ? 'bg-accent/20 text-fg' : 'text-muted hover:bg-panel-2'}`}
            >
              {m === 'unified' ? 'Unified' : 'Side by side'}
            </button>
          ))}
        </div>
        <button
          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2"
          onClick={() => showDiff(null)}
        >
          Close
        </button>
      </div>
      {mode === 'split' ? (
        <div className="min-h-0 flex-1">
          {contents.isPending ? (
            <div className="p-4 text-xs text-muted">Loading…</div>
          ) : contents.isError ? (
            <div className="p-4 text-xs text-danger">{contents.error.message}</div>
          ) : contents.data.binary ? (
            <div className="p-4 text-xs text-muted" data-testid="diff-binary">
              Binary file — no text diff available.
            </div>
          ) : contents.data.tooLarge ? (
            <div className="p-4 text-xs text-warn">This file is too large to show side by side. Use the unified view.</div>
          ) : (
            <Suspense fallback={<div className="p-4 text-xs text-muted">Loading editor…</div>}>
              <SideBySideDiff
                path={target.path}
                original={contents.data.oldText ?? ''}
                modified={contents.data.newText ?? ''}
              />
            </Suspense>
          )}
        </div>
      ) : (
        <UnifiedDiff repoPath={repoPath} target={target} diff={diff} />
      )}
    </div>
  )
}

type DiffQuery = ReturnType<typeof useFileDiff>

function UnifiedDiff({ repoPath, target, diff }: { repoPath: string; target: DiffTarget; diff: DiffQuery }) {
  return (
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
        // Re-key on the hunk headers so line selections reset whenever the diff changes.
        <HunkTable
          key={diff.data.hunks.map((h) => h.header).join('|')}
          repoPath={repoPath}
          target={target}
          data={diff.data}
        />
      )}
      {diff.data?.truncated && (
        <div className="p-3 text-center text-warn">Diff truncated: the file is too large to display fully.</div>
      )}
    </div>
  )
}

function HunkTable({ repoPath, target, data }: { repoPath: string; target: DiffTarget; data: FileDiff }) {
  const [selected, setSelected] = useState<Map<number, Set<number>>>(new Map())
  const showError = useUiStore((s) => s.showError)
  const apply = useRepoMutation(
    repoPath,
    (vars: { action: 'stage' | 'unstage' | 'discard'; selections: HunkSelection[] }) =>
      call('diff:apply-hunks', {
        repoPath,
        path: target.path,
        source: target.kind === 'staged' ? 'staged' : 'unstaged',
        ...vars,
      }),
    { history: false },
  )

  // Partial staging only makes sense for a modified file present on both sides.
  const editable =
    (target.kind === 'unstaged' || target.kind === 'staged') && !data.isNew && !data.isDeleted && !data.oldPath

  const toggle = (hunk: number, line: number): void => {
    setSelected((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(hunk))
      if (set.has(line)) set.delete(line)
      else set.add(line)
      if (set.size === 0) next.delete(hunk)
      else next.set(hunk, set)
      return next
    })
  }

  const run = (action: 'stage' | 'unstage' | 'discard', hunkIndex: number): void => {
    const lines = selected.get(hunkIndex)
    const hunk = data.hunks[hunkIndex]!
    apply.mutate(
      { action, selections: [{ hunkIndex, header: hunk.header, ...(lines ? { lines: [...lines].sort((a, b) => a - b) } : {}) }] },
      { onError: (e) => showError(e), onSuccess: () => setSelected(new Map()) },
    )
  }

  return (
    <table className="w-full border-collapse" data-testid="diff-table">
      <tbody>
        {data.hunks.map((h, hi) => {
          const sel = selected.get(hi)
          const suffix = sel ? ` ${sel.size} line${sel.size === 1 ? '' : 's'}` : ' hunk'
          return (
            <Fragment key={hi}>
              <tr className="bg-info/10 text-info" data-testid="hunk-header">
                <td colSpan={3} className="px-3 py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{h.header}</span>
                    {editable && (
                      <span className="ml-auto flex shrink-0 gap-1 font-sans">
                        {target.kind === 'unstaged' ? (
                          <>
                            <HunkButton disabled={apply.isPending} onClick={() => run('discard', hi)} danger>
                              Discard{suffix}
                            </HunkButton>
                            <HunkButton disabled={apply.isPending} onClick={() => run('stage', hi)}>
                              Stage{suffix}
                            </HunkButton>
                          </>
                        ) : (
                          <HunkButton disabled={apply.isPending} onClick={() => run('unstage', hi)}>
                            Unstage{suffix}
                          </HunkButton>
                        )}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
              {h.lines.map((l, i) => {
                const selectable = editable && (l.type === 'add' || l.type === 'del')
                const isSel = sel?.has(i) ?? false
                return (
                  <tr
                    key={i}
                    className={`${lineCls[l.type]} ${isSel ? 'outline outline-1 -outline-offset-1 outline-accent' : ''} ${
                      selectable ? 'cursor-pointer' : ''
                    }`}
                    data-line-type={l.type}
                    data-selected={isSel || undefined}
                    title={selectable ? 'Click to select this line for staging' : undefined}
                    onClick={selectable ? () => toggle(hi, i) : undefined}
                  >
                    <td className="w-12 border-r border-border px-2 text-right text-muted select-none">
                      {isSel ? '✓' : (l.oldLine ?? '')}
                    </td>
                    <td className="w-12 border-r border-border px-2 text-right text-muted select-none">{l.newLine ?? ''}</td>
                    <td className="px-2 whitespace-pre">
                      <span className="select-none text-muted">{prefix[l.type]}</span>
                      {l.content}
                    </td>
                  </tr>
                )
              })}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function HunkButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`rounded border border-border bg-bg px-1.5 text-[11px] leading-4 disabled:opacity-40 ${
        danger ? 'text-err hover:bg-err/10' : 'text-fg hover:bg-panel-2'
      }`}
    >
      {children}
    </button>
  )
}

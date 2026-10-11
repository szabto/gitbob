import type { DiffLine, DiffTarget, FileDiff, HunkSelection, PullRequestComment } from '@shared/types'
import { Fragment, lazy, Suspense, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useFileContents, useFileDiff, useRepoMutation } from '../lib/queries'
import { useUiStore } from '../state/ui'
import { formatDate } from '../lib/format'
import { useAppStore } from '../state/store'

const targetLabel: Record<DiffTarget['kind'], string> = {
  unstaged: 'Unstaged changes',
  staged: 'Staged changes',
  untracked: 'New file',
  commit: 'Commit',
  range: 'Pull request',
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
const FileEditor = lazy(() => import('./FileEditor').then((m) => ({ default: m.FileEditor })))

export function DiffView({
  repoPath,
  target,
  onClose,
  showHistoryButton = true,
}: {
  repoPath: string
  target: DiffTarget
  /** Embedded use (file history): replaces the default close (clearing the shown diff). */
  onClose?: () => void
  showHistoryButton?: boolean
}) {
  const diff = useFileDiff(repoPath, target)
  const [editing, setEditing] = useState(false)
  const showDiff = useAppStore((s) => s.showDiff)
  const openBlame = useAppStore((s) => s.openBlame)
  const openFileHistory = useAppStore((s) => s.openFileHistory)
  const mode = useUiStore((s) => s.diffMode)
  const setMode = useUiStore((s) => s.setDiffMode)
  const contents = useFileContents(repoPath, target, mode === 'split')

  if (editing) {
    return (
      <Suspense fallback={<div className="p-4 text-xs text-muted">Loading editor…</div>}>
        <FileEditor repoPath={repoPath} path={target.path} onDone={() => setEditing(false)} />
      </Suspense>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="diff-view">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">
          {targetLabel[target.kind]}
          {target.kind === 'commit' ? ` ${target.sha.slice(0, 7)}` : ''}
          {target.kind === 'range' ? ` ${target.base.slice(0, 7)}…${target.head.slice(0, 7)}` : ''}
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
        {target.kind !== 'untracked' && !diff.data?.isDeleted && (
          <button
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2"
            title="Show who last changed each line"
            onClick={() =>
              openBlame({
                path: target.path,
                ...(target.kind === 'commit' ? { rev: target.sha } : target.kind === 'range' ? { rev: target.head } : {}),
              })
            }
          >
            Blame
          </button>
        )}
        {(target.kind === 'unstaged' || target.kind === 'untracked') && !diff.data?.binary && !diff.data?.isDeleted && (
          <button
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2"
            title="Edit this file here"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
        {showHistoryButton && target.kind !== 'untracked' && (
          <button
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2"
            title="Show every commit that changed this file"
            onClick={() => openFileHistory(target.path)}
          >
            History
          </button>
        )}
        <button
          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2"
          onClick={() => (onClose ? onClose() : showDiff(null))}
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

type Side = 'old' | 'new'
const lineKey = (side: Side, line: number): string => `${side}:${line}`
/** Where a diff line can carry a review comment: removed lines on the old side, others on the new side. */
const lineAnchor = (l: DiffLine): { side: Side; line: number } | null =>
  l.type === 'del' && l.oldLine != null ? { side: 'old', line: l.oldLine } : l.type !== 'no-newline' && l.newLine != null ? { side: 'new', line: l.newLine } : null

/** Inline review comments of the open pull request for a range (pull request) diff. */
function usePrReview(repoPath: string, target: DiffTarget) {
  const prNumber = useAppStore((s) => s.prNumber)
  const enabled = target.kind === 'range' && prNumber != null
  const qc = useQueryClient()
  const comments = useQuery({
    queryKey: ['pr-comments', repoPath, prNumber],
    queryFn: () => call('provider:pr-comments', { repoPath, number: prNumber! }),
    enabled,
  })
  const add = useMutation({
    mutationFn: (v: { side: Side; line: number; body: string }) =>
      call('provider:pr-line-comment', {
        repoPath,
        number: prNumber!,
        path: target.path,
        ...(target.kind === 'range' && target.oldPath ? { oldPath: target.oldPath } : {}),
        ...v,
        headSha: target.kind === 'range' ? target.head : '',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pr-comments', repoPath, prNumber] }),
  })
  if (!enabled) return null
  const byLine = new Map<string, PullRequestComment[]>()
  for (const c of comments.data ?? []) {
    if (c.line == null || (c.path !== target.path && !(c.side === 'old' && target.kind === 'range' && c.path === target.oldPath))) continue
    const k = lineKey(c.side ?? 'new', c.line)
    byLine.set(k, [...(byLine.get(k) ?? []), c])
  }
  return { byLine, add }
}

function HunkTable({ repoPath, target, data }: { repoPath: string; target: DiffTarget; data: FileDiff }) {
  const [selected, setSelected] = useState<Map<number, Set<number>>>(new Map())
  const [drafting, setDrafting] = useState<string | null>(null)
  const review = usePrReview(repoPath, target)
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
                const anchor = review ? lineAnchor(l) : null
                const key = anchor ? lineKey(anchor.side, anchor.line) : null
                const thread = key ? (review?.byLine.get(key) ?? []) : []
                return (
                  <Fragment key={i}>
                  <tr
                    className={`group ${lineCls[l.type]} ${isSel ? 'outline outline-1 -outline-offset-1 outline-accent' : ''} ${
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
                    <td className="relative px-2 whitespace-pre">
                      {anchor && (
                        <button
                          type="button"
                          aria-label={`Comment on line ${anchor.line}`}
                          data-testid="add-line-comment"
                          onClick={() => setDrafting(key)}
                          className="absolute top-0 -left-2.5 z-10 h-4 w-4 rounded bg-accent text-[11px] leading-4 font-bold text-on-accent opacity-0 group-hover:opacity-100 focus:opacity-100"
                        >
                          +
                        </button>
                      )}
                      <span className="select-none text-muted">{prefix[l.type]}</span>
                      {l.content}
                    </td>
                  </tr>
                  {(thread.length > 0 || drafting === key) && anchor && review && (
                    <tr data-testid="line-comments" data-line={key}>
                      <td colSpan={3} className="border-y border-border bg-panel px-3 py-2 font-sans">
                        {thread.map((c) => (
                          <div key={c.id} className="mb-2 max-w-3xl" data-testid="line-comment">
                            <div className="text-xs text-muted">
                              <strong className="text-fg">{c.author}</strong> · {formatDate(Date.parse(c.createdAt) / 1000)}
                            </div>
                            <div className="whitespace-pre-wrap">{c.body}</div>
                          </div>
                        ))}
                        {drafting === key ? (
                          <LineCommentForm
                            line={anchor.line}
                            busy={review.add.isPending}
                            onCancel={() => setDrafting(null)}
                            onSubmit={(body) =>
                              review.add.mutate(
                                { ...anchor, body },
                                { onError: (e) => showError(e), onSuccess: () => setDrafting(null) },
                              )
                            }
                          />
                        ) : (
                          <button className="text-xs text-accent hover:underline" onClick={() => setDrafting(key)}>
                            Add a comment
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function LineCommentForm({ line, busy, onSubmit, onCancel }: { line: number; busy: boolean; onSubmit: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState('')
  return (
    <form
      className="max-w-3xl"
      onSubmit={(e) => {
        e.preventDefault()
        if (body.trim()) onSubmit(body.trim())
      }}
    >
      <textarea
        autoFocus
        rows={3}
        value={body}
        aria-label={`Your comment on line ${line}`}
        placeholder="Leave a comment on this line"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) onSubmit(body.trim())
        }}
        className="w-full resize-y rounded border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-accent"
      />
      <div className="mt-1 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded border border-border px-2 py-0.5 text-sm hover:bg-panel-2">
          Cancel
        </button>
        <button type="submit" disabled={busy || !body.trim()} className="rounded bg-accent px-2 py-0.5 text-sm font-medium text-on-accent disabled:opacity-40">
          Comment
        </button>
      </div>
    </form>
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

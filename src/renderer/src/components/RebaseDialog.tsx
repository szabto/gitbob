import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RebaseAction, RebaseCommit, RebaseTodoItem } from '@shared/types'
import { call } from '../lib/api'
import { useDialog } from '../lib/useDialog'
import { useRepoMutation } from '../lib/queries'
import { formatShortDate, shortSha } from '../lib/format'
import { useUiStore } from '../state/ui'

const ACTIONS: { value: RebaseAction; label: string; hint: string }[] = [
  { value: 'pick', label: 'Pick', hint: 'Keep the commit' },
  { value: 'reword', label: 'Reword', hint: 'Keep it, change the message' },
  { value: 'squash', label: 'Squash', hint: 'Merge into the commit above, combine messages' },
  { value: 'fixup', label: 'Fixup', hint: 'Merge into the commit above, keep its message' },
  { value: 'drop', label: 'Drop', hint: 'Remove the commit' },
]

interface Row extends RebaseCommit {
  action: RebaseAction
  message: string
}

/** Interactive rebase of base..HEAD: reorder, reword, squash, fixup or drop commits. */
export function RebaseDialog({ repoPath, base, onClose }: { repoPath: string; base: string; onClose: () => void }) {
  const dialogRef = useDialog<HTMLDivElement>(onClose)
  const todo = useQuery({
    queryKey: ['rebase-todo', repoPath, base],
    queryFn: () => call('rebase:todo', { repoPath, base }),
    gcTime: 0,
  })

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[8vh]" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="Interactive rebase"
        data-testid="rebase-dialog"
        className="flex max-h-[80vh] w-[760px] max-w-[94vw] flex-col rounded-lg border border-border bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-4">
          <h2 className="font-semibold">Interactive rebase</h2>
          <p className="mt-1 text-xs text-muted">
            Commits after {shortSha(base)}, oldest first. Reorder them, change what happens to each, then start. If a
            conflict stops the rebase, resolve it and press Continue in the banner, or Abort to undo everything.
          </p>
        </div>
        {todo.isPending ? (
          <div className="p-4 text-xs text-muted">Loading…</div>
        ) : todo.isError ? (
          <div className="p-4 text-sm text-err">{todo.error.message}</div>
        ) : todo.data.length === 0 ? (
          <div className="p-4 text-sm text-muted">There are no commits after this one on the current branch.</div>
        ) : (
          <RebaseEditor repoPath={repoPath} base={base} commits={todo.data} onClose={onClose} />
        )}
      </div>
    </div>
  )
}

function RebaseEditor({
  repoPath,
  base,
  commits,
  onClose,
}: {
  repoPath: string
  base: string
  commits: RebaseCommit[]
  onClose: () => void
}) {
  const [rows, setRows] = useState<Row[]>(() => commits.map((c) => ({ ...c, action: 'pick', message: c.subject })))
  const showError = useUiStore((s) => s.showError)
  const showNotice = useUiStore((s) => s.showNotice)
  const start = useRepoMutation(repoPath, (todo: RebaseTodoItem[]) => call('rebase:start', { repoPath, base, todo }))

  const update = (i: number, patch: Partial<Row>): void =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  const move = (i: number, delta: number): void =>
    setRows((r) => {
      const j = i + delta
      if (j < 0 || j >= r.length) return r
      const next = [...r]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })

  const firstKept = rows.find((r) => r.action !== 'drop')
  const problem =
    firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')
      ? 'The first remaining commit cannot be squashed or fixed up: there is nothing above it to merge into.'
      : rows.some((r) => r.action === 'reword' && !r.message.trim())
        ? 'A reworded commit needs a message.'
        : rows.every((r) => r.action === 'drop')
          ? 'Dropping every commit is not allowed here; use Reset instead.'
          : null
  const unchanged = rows.every((r, i) => r.action === 'pick' && r.sha === commits[i]!.sha)

  const submit = (): void => {
    const todo: RebaseTodoItem[] = rows.map((r) => ({
      sha: r.sha,
      action: r.action,
      ...(r.action === 'reword' ? { message: r.message } : {}),
    }))
    start.mutate(todo, {
      onError: showError,
      onSuccess: (res) => {
        if (!res.completed) showNotice('The rebase stopped on a conflict. Resolve it, then press Continue in the banner.')
        onClose()
      },
    })
  }

  return (
    <>
      <ol className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="rebase-rows">
        {rows.map((r, i) => (
          <li
            key={r.sha}
            data-testid="rebase-row"
            data-sha={r.sha}
            className={`mb-1 rounded border border-border p-2 ${r.action === 'drop' ? 'opacity-50' : ''}`}
          >
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <button aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="px-1 text-xs text-muted hover:text-fg disabled:opacity-20">
                  ▲
                </button>
                <button aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="px-1 text-xs text-muted hover:text-fg disabled:opacity-20">
                  ▼
                </button>
              </div>
              <select
                aria-label={`Action for ${r.subject}`}
                value={r.action}
                onChange={(e) => update(i, { action: e.target.value as RebaseAction })}
                className="rounded border border-border bg-bg px-1.5 py-1 text-xs"
              >
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value} title={a.hint}>
                    {a.label}
                  </option>
                ))}
              </select>
              <span className="font-mono text-xs text-muted">{shortSha(r.sha)}</span>
              <span className={`min-w-0 flex-1 truncate ${r.action === 'drop' ? 'line-through' : ''}`}>{r.subject}</span>
              <span className="shrink-0 text-xs text-muted">
                {r.authorName} · {formatShortDate(r.time)}
              </span>
            </div>
            {r.action === 'reword' && (
              <textarea
                aria-label={`New message for ${r.subject}`}
                value={r.message}
                onChange={(e) => update(i, { message: e.target.value })}
                rows={2}
                className="mt-2 w-full resize-none rounded border border-border bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
              />
            )}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 border-t border-border p-3">
        {problem && <span className="text-xs text-err">{problem}</span>}
        <span className="ml-auto" />
        <button className="rounded border border-border px-3 py-1 hover:bg-panel-2" onClick={onClose}>
          Cancel
        </button>
        <button
          disabled={!!problem || unchanged || start.isPending}
          onClick={submit}
          className="rounded bg-gradient-to-r from-accent to-accent-2 px-3 py-1 font-medium text-on-accent disabled:opacity-40"
        >
          {start.isPending ? 'Rebasing…' : 'Start rebase'}
        </button>
      </div>
    </>
  )
}

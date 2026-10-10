import { useState } from 'react'
import type { DiffTarget, RepositoryInfo, StatusEntry } from '@shared/types'
import { call } from '../lib/api'
import { useRepoMutation, useStatus } from '../lib/queries'
import { groupStatus, statusBadge } from '../lib/status'
import { useAppStore } from '../state/store'

export function StagingPanel({ repo, onStash }: { repo: RepositoryInfo; onStash: () => void }) {
  const repoPath = repo.root
  const status = useStatus(repoPath)
  const showDiff = useAppStore((s) => s.showDiff)
  const diffTarget = useAppStore((s) => s.diffTarget)
  const groups = groupStatus(status.data)

  const stage = useRepoMutation(repoPath, (paths: string[]) => call('index:stage', { repoPath, paths }), {
    history: false,
  })
  const unstage = useRepoMutation(repoPath, (paths: string[]) => call('index:unstage', { repoPath, paths }), {
    history: false,
  })
  const stageAll = useRepoMutation(repoPath, () => call('index:stage-all', { repoPath }), { history: false })
  const unstageAll = useRepoMutation(repoPath, () => call('index:unstage-all', { repoPath }), { history: false })
  const discard = useRepoMutation(repoPath, (paths: string[]) => call('worktree:discard', { repoPath, paths }), {
    history: false,
  })

  const busy = stage.isPending || unstage.isPending || stageAll.isPending || unstageAll.isPending || discard.isPending
  const error = [stage, unstage, stageAll, unstageAll, discard].find((m) => m.error)?.error

  const isActive = (t: DiffTarget): boolean =>
    !!diffTarget && diffTarget.kind === t.kind && diffTarget.path === t.path

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-panel" data-testid="staging-panel">
      <div className="flex h-7 shrink-0 items-center border-b border-border px-3 text-xs font-semibold text-muted">
        Working changes
        {status.data?.branch.head && <span className="ml-1 font-normal">on {status.data.branch.head}</span>}
        {status.data?.operation ? (
          <span className="ml-auto rounded bg-warn/20 px-1.5 text-warn" data-testid="operation">
            {status.data.operation} in progress
          </span>
        ) : (
          <button
            onClick={onStash}
            disabled={busy || !status.data?.branch.oid || (groups.unstaged.length === 0 && groups.staged.length === 0)}
            title="Save all changes to a stash and clean the working tree"
            className="ml-auto rounded border border-border px-2 py-0.5 font-normal text-fg hover:bg-fg/5 disabled:opacity-40"
          >
            Stash…
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="border-b border-err/40 bg-err/10 px-3 py-1.5 text-xs text-err">
          {error.message}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {groups.conflicted.length > 0 && (
          <FileSection
            title="Conflicts"
            testId="conflicted-files"
            entries={groups.conflicted}
            side="worktree"
            action={{ label: 'Mark resolved', run: (p) => stage.mutate(p) }}
            onOpen={(e) => showDiff({ kind: 'unstaged', path: e.path })}
            isActive={(e) => isActive({ kind: 'unstaged', path: e.path })}
            disabled={busy}
          />
        )}
        <FileSection
          title="Unstaged files"
          testId="unstaged-files"
          entries={groups.unstaged}
          side="worktree"
          headerAction={
            groups.unstaged.length > 0 ? { label: 'Stage all', run: () => stageAll.mutate() } : undefined
          }
          action={{ label: 'Stage', run: (p) => stage.mutate(p) }}
          secondaryAction={{ label: 'Discard', run: (p) => discard.mutate(p), danger: true }}
          onOpen={(e) =>
            showDiff(e.kind === 'untracked' ? { kind: 'untracked', path: e.path } : { kind: 'unstaged', path: e.path })
          }
          isActive={(e) => isActive({ kind: e.kind === 'untracked' ? 'untracked' : 'unstaged', path: e.path })}
          disabled={busy}
        />
        <FileSection
          title="Staged files"
          testId="staged-files"
          entries={groups.staged}
          side="index"
          headerAction={
            groups.staged.length > 0 ? { label: 'Unstage all', run: () => unstageAll.mutate() } : undefined
          }
          action={{ label: 'Unstage', run: (p) => unstage.mutate(p) }}
          onOpen={(e) => showDiff({ kind: 'staged', path: e.path })}
          isActive={(e) => isActive({ kind: 'staged', path: e.path })}
          disabled={busy}
        />
      </div>

      <CommitComposer repoPath={repoPath} stagedCount={groups.staged.length} unborn={!status.data?.branch.oid} />
    </aside>
  )
}

interface Action {
  label: string
  run: (paths: string[]) => void
  danger?: boolean
}

function FileSection({
  title,
  testId,
  entries,
  side,
  headerAction,
  action,
  secondaryAction,
  onOpen,
  isActive,
  disabled,
}: {
  title: string
  testId: string
  entries: StatusEntry[]
  side: 'index' | 'worktree'
  headerAction?: { label: string; run: () => void }
  action: Action
  secondaryAction?: Action
  onOpen: (e: StatusEntry) => void
  isActive: (e: StatusEntry) => boolean
  disabled: boolean
}) {
  return (
    <section className="flex min-h-[80px] flex-1 flex-col border-b border-border" data-testid={testId}>
      <div className="flex h-7 shrink-0 items-center gap-2 bg-panel-2 px-3 text-xs">
        <span className="font-semibold">{title}</span>
        <span className="text-muted">{entries.length}</span>
        {headerAction && (
          <button
            disabled={disabled}
            onClick={headerAction.run}
            className="ml-auto rounded border border-border px-2 py-0.5 hover:bg-fg/5 disabled:opacity-50"
          >
            {headerAction.label}
          </button>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 && <li className="px-3 py-2 text-xs text-muted">No files</li>}
        {entries.map((e) => {
          const code = side === 'index' ? e.index : e.kind === 'untracked' ? '?' : e.worktree
          const badge = statusBadge(code)
          return (
            <li
              key={e.path}
              data-testid="status-file"
              data-path={e.path}
              className={`group flex h-7 cursor-default items-center gap-2 px-3 font-mono text-xs ${
                isActive(e) ? 'bg-accent/20' : 'hover:bg-fg/[0.04]'
              }`}
              onClick={() => onOpen(e)}
            >
              <span className={`w-3 shrink-0 font-bold ${badge.cls}`} title={badge.title}>
                {badge.label}
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                title={e.origPath ? `${e.origPath} → ${e.path}` : e.path}
              >
                {e.origPath && side === 'index' ? `${e.origPath} → ` : ''}
                {e.path}
              </span>
              {secondaryAction && (
                <button
                  disabled={disabled}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    secondaryAction.run([e.path])
                  }}
                  className="hidden rounded px-1.5 py-0.5 font-sans text-err group-hover:block hover:bg-err/20 disabled:opacity-50"
                >
                  {secondaryAction.label}
                </button>
              )}
              <button
                disabled={disabled}
                onClick={(ev) => {
                  ev.stopPropagation()
                  action.run([e.path])
                }}
                className="hidden rounded px-1.5 py-0.5 font-sans group-hover:block hover:bg-fg/10 disabled:opacity-50"
              >
                {action.label}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function CommitComposer({ repoPath, stagedCount, unborn }: { repoPath: string; stagedCount: number; unborn: boolean }) {
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [amend, setAmend] = useState(false)
  const select = useAppStore((s) => s.select)

  const commit = useRepoMutation(repoPath, (vars: { message: string; amend: boolean }) =>
    call('commit:create', { repoPath, ...vars }),
  )

  const toggleAmend = async (on: boolean): Promise<void> => {
    setAmend(on)
    if (on && !summary.trim() && !description.trim()) {
      const last = await call('commit:last-message', { repoPath }).catch(() => null)
      if (last) {
        const [first = '', ...rest] = last.split('\n')
        setSummary(first)
        setDescription(rest.join('\n').replace(/^\n+/, ''))
      }
    }
  }

  const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim()
  const canCommit = !!summary.trim() && (stagedCount > 0 || amend) && !commit.isPending

  const submit = (): void => {
    if (!canCommit) return
    commit.mutate(
      { message, amend },
      {
        onSuccess: (res) => {
          setSummary('')
          setDescription('')
          setAmend(false)
          // Show the new commit; the WIP row remains if there are still uncommitted changes.
          select(res.sha)
        },
      },
    )
  }

  return (
    <form
      className="shrink-0 p-3"
      data-testid="commit-composer"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="mb-1 flex items-center text-xs">
        <span className="font-semibold">{amend ? 'Amend previous commit' : 'Commit'}</span>
        <label className="ml-auto flex items-center gap-1 text-muted">
          <input
            type="checkbox"
            checked={amend}
            disabled={unborn}
            onChange={(e) => void toggleAmend(e.target.checked)}
            data-testid="amend-checkbox"
          />
          Amend
        </label>
      </div>
      <div className="relative">
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Summary (required)"
          aria-label="Commit summary"
          className="w-full rounded border border-border bg-bg px-2 py-1.5 outline-none focus:border-accent"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
        <span
          className={`absolute top-1.5 right-2 text-xs ${summary.length > 72 ? 'text-warn' : 'text-muted'}`}
        >
          {summary.length}
        </span>
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        aria-label="Commit description"
        rows={3}
        className="mt-2 w-full resize-none rounded border border-border bg-bg px-2 py-1.5 outline-none focus:border-accent"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
      />
      {commit.error && (
        <div role="alert" className="selectable mb-2 text-xs whitespace-pre-wrap text-err" data-testid="commit-error">
          {commit.error.message}
        </div>
      )}
      <button
        type="submit"
        disabled={!canCommit}
        className="w-full rounded bg-gradient-to-r from-accent to-accent-2 py-1.5 font-medium text-[#0b1220] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {commit.isPending
          ? 'Committing…'
          : amend
            ? 'Amend commit'
            : stagedCount > 0
              ? `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`
              : 'Stage files to commit'}
      </button>
    </form>
  )
}

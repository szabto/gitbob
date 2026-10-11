import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DiffTarget, RepositoryInfo, StatusEntry } from '@shared/types'
import { call } from '../lib/api'
import { useHistory, useRepoMutation, useStatus } from '../lib/queries'
import {
  addCoAuthor,
  applyType,
  CONVENTIONAL_TYPES,
  currentType,
  loadDraft,
  recentCoAuthors,
  saveDraft,
  summaryHint,
  usesConventionalCommits,
} from '../lib/commit-message'
import { useUiStore, type MenuEntry } from '../state/ui'
import { groupStatus, statusBadge } from '../lib/status'
import { useAppStore } from '../state/store'

export function StagingPanel({
  repo,
  onStash,
  onStashFiles,
}: {
  repo: RepositoryInfo
  onStash: () => void
  onStashFiles?: (paths: string[]) => void
}) {
  const repoPath = repo.root
  const status = useStatus(repoPath)
  const [selection, setSelection] = useState<{ section: 'unstaged' | 'staged' | null; paths: string[]; anchor: string | null }>({
    section: null,
    paths: [],
    anchor: null,
  })
  const clearSelection = (): void => setSelection({ section: null, paths: [], anchor: null })
  const selectedIn = (section: 'unstaged' | 'staged'): Set<string> => new Set(selection.section === section ? selection.paths : [])
  /** Returns true when the click changed the selection instead of opening the file. */
  const onSelect = (section: 'unstaged' | 'staged', list: StatusEntry[], e: StatusEntry, ev: React.MouseEvent): boolean => {
    const additive = ev.metaKey || ev.ctrlKey
    const same = selection.section === section
    if (ev.shiftKey && same && selection.anchor) {
      const i = list.findIndex((x) => x.path === selection.anchor)
      const j = list.findIndex((x) => x.path === e.path)
      if (i >= 0 && j >= 0) {
        const range = list.slice(Math.min(i, j), Math.max(i, j) + 1).map((x) => x.path)
        setSelection({ section, paths: [...new Set([...(additive ? selection.paths : []), ...range])], anchor: selection.anchor })
        return true
      }
    }
    if (additive) {
      const base = same ? selection.paths : []
      const paths = base.includes(e.path) ? base.filter((p) => p !== e.path) : [...base, e.path]
      setSelection({ section, paths, anchor: e.path })
      return true
    }
    setSelection({ section, paths: [e.path], anchor: e.path })
    return false
  }
  const showDiff = useAppStore((s) => s.showDiff)
  const diffTarget = useAppStore((s) => s.diffTarget)
  const openConflict = useAppStore((s) => s.openConflict)
  const conflictPath = useAppStore((s) => s.conflictPath)
  const groups = groupStatus(status.data)
  const selectionList = selection.section === 'unstaged' ? groups.unstaged : selection.section === 'staged' ? groups.staged : []
  const selectedEntries = selectionList.filter((e) => selection.paths.includes(e.path))
  // "Commit selected" applies to a real multi-selection; a single click just opens a file.
  const selectedPaths = selectedEntries.length >= 2 ? selectedEntries.flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path])) : []

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

      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(e) => e.key === 'Escape' && setSelection({ section: null, paths: [], anchor: null })}
      >
        {groups.conflicted.length > 0 && (
          <FileSection
            title="Conflicts"
            testId="conflicted-files"
            entries={groups.conflicted}
            side="worktree"
            action={{ label: 'Mark resolved', run: (p) => stage.mutate(p) }}
            onOpen={(e) => openConflict(e.path)}
            isActive={(e) => conflictPath === e.path}
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
          selected={selectedIn('unstaged')}
          onSelect={(e, ev) => onSelect('unstaged', groups.unstaged, e, ev)}
          onClearSelection={clearSelection}
          selectionActions={[
            { label: 'Stage', run: (p) => (stage.mutate(p), clearSelection()) },
            ...(onStashFiles && status.data?.branch.oid ? [{ label: 'Stash', run: (p: string[]) => (onStashFiles(p), clearSelection()) }] : []),
            { label: 'Discard', danger: true, run: (p) => (discard.mutate(p), clearSelection()) },
          ]}
          menu={(e) => [
            ...(onStashFiles && status.data?.branch.oid ? [{ label: `Stash ${e.path}…`, onSelect: () => onStashFiles([e.path]) }] : []),
            ...(e.kind !== 'untracked' ? [{ label: 'File history', onSelect: () => useAppStore.getState().openFileHistory(e.path) }] : []),
          ]}
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
          selected={selectedIn('staged')}
          onSelect={(e, ev) => onSelect('staged', groups.staged, e, ev)}
          onClearSelection={clearSelection}
          selectionActions={[{ label: 'Unstage', run: (p) => (unstage.mutate(p), clearSelection()) }]}
          menu={(e) => [
            ...(onStashFiles && status.data?.branch.oid ? [{ label: `Stash ${e.path}…`, onSelect: () => onStashFiles([e.path]) }] : []),
            ...(e.kind !== 'untracked' ? [{ label: 'File history', onSelect: () => useAppStore.getState().openFileHistory(e.path) }] : []),
          ]}
          onOpen={(e) => showDiff({ kind: 'staged', path: e.path, ...(e.origPath ? { oldPath: e.origPath } : {}) })}
          isActive={(e) => isActive({ kind: 'staged', path: e.path })}
          disabled={busy}
        />
      </div>

      <CommitComposer
        key={repoPath}
        repoPath={repoPath}
        stagedCount={groups.staged.length}
        unborn={!status.data?.branch.oid}
        selectedPaths={selectedPaths}
        onCommitted={clearSelection}
      />
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
  menu,
  isActive,
  disabled,
  selected,
  onSelect,
  selectionActions,
  onClearSelection,
}: {
  title: string
  testId: string
  entries: StatusEntry[]
  side: 'index' | 'worktree'
  headerAction?: { label: string; run: () => void }
  action: Action
  secondaryAction?: Action
  onOpen: (e: StatusEntry) => void
  /** Right-click menu for a file. */
  menu?: (e: StatusEntry) => MenuEntry[]
  isActive: (e: StatusEntry) => boolean
  disabled: boolean
  /** Multi-selection in this section (paths). */
  selected?: Set<string>
  onSelect?: (e: StatusEntry, ev: React.MouseEvent) => boolean
  /** Actions for the selection, shown when two or more files are selected. */
  selectionActions?: { label: string; run: (paths: string[]) => void; danger?: boolean }[]
  onClearSelection?: () => void
}) {
  const sel = selected ?? new Set<string>()
  const many = sel.size >= 2
  return (
    <section className="flex min-h-[80px] flex-1 flex-col border-b border-border" data-testid={testId}>
      <div className="flex h-7 shrink-0 items-center gap-2 bg-panel-2 px-3 text-xs">
        <span className="font-semibold">{title}</span>
        <span className="text-muted">{entries.length}</span>
        {many ? (
          <div className="ml-auto flex items-center gap-1" data-testid="selection-bar">
            <span className="text-accent">{sel.size} selected</span>
            {selectionActions?.map((a) => (
              <button
                key={a.label}
                disabled={disabled}
                onClick={() => a.run([...sel])}
                className={`rounded border border-border px-1.5 py-0.5 hover:bg-fg/5 disabled:opacity-50 ${a.danger ? 'text-err' : ''}`}
              >
                {a.label}
              </button>
            ))}
            <button aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClearSelection} className="px-1 text-muted hover:text-fg">
              ✕
            </button>
          </div>
        ) : headerAction && (
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
              data-selected={sel.has(e.path) || undefined}
              className={`group flex h-7 cursor-default items-center gap-2 px-3 font-mono text-xs select-none ${
                sel.has(e.path) && many ? 'bg-accent/30' : isActive(e) ? 'bg-accent/20' : 'hover:bg-fg/[0.04]'
              }`}
              onClick={(ev) => {
                // ⌘/Ctrl-click and Shift-click change the selection without opening a diff.
                if (onSelect?.(e, ev)) return
                onOpen(e)
              }}
              onContextMenu={(ev) => {
                const items = menu?.(e) ?? []
                if (!items.length) return
                ev.preventDefault()
                useUiStore.getState().openMenu(ev.clientX, ev.clientY, items)
              }}
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

function CommitComposer({
  repoPath,
  stagedCount,
  unborn,
  selectedPaths = [],
  onCommitted,
}: {
  repoPath: string
  stagedCount: number
  unborn: boolean
  /** Files to commit instead of the staged changes (multi-selection). */
  selectedPaths?: string[]
  onCommitted?: () => void
}) {
  const [draft] = useState(() => loadDraft(repoPath))
  const [summary, setSummary] = useState(draft?.summary ?? '')
  const [description, setDescription] = useState(draft?.description ?? '')
  const [amend, setAmend] = useState(false)
  const select = useAppStore((s) => s.select)
  const openMenu = useUiStore((s) => s.openMenu)

  // The unsent message survives tab switches and restarts (amend prefill is not saved over it).
  useEffect(() => {
    if (!amend) saveDraft(repoPath, { summary, description })
  }, [repoPath, summary, description, amend])

  // A configured commit.template fills an empty message once.
  const template = useQuery({ queryKey: ['commit-template', repoPath], queryFn: () => call('commit:template', { repoPath }), staleTime: Infinity })
  const [templateUsed, setTemplateUsed] = useState(!!draft)
  if (!templateUsed && template.data !== undefined) {
    setTemplateUsed(true)
    if (template.data && !summary && !description) {
      const [first = '', ...rest] = template.data.split('\n')
      setSummary(first)
      setDescription(rest.join('\n').replace(/^\n+/, ''))
    }
  }

  const history = useHistory(repoPath)
  const identity = useQuery({ queryKey: ['git-identity'], queryFn: () => call('app:git-identity', {}) })
  const recent = useMemo(() => history.data?.pages[0]?.commits.slice(0, 300) ?? [], [history.data])
  const conventional = useMemo(() => usesConventionalCommits(recent.map((c) => c.subject)), [recent])
  const coAuthors = useMemo(() => recentCoAuthors(recent, identity.data ?? null), [recent, identity.data])
  const hint = summaryHint(summary)

  const commit = useRepoMutation(repoPath, (vars: { message: string; amend: boolean; paths?: string[] }) =>
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
  const selectedCount = new Set(selectedPaths).size
  const canCommit = !!summary.trim() && (stagedCount > 0 || amend || selectedCount > 0) && !commit.isPending

  const submit = (): void => {
    if (!canCommit) return
    commit.mutate(
      { message, amend, ...(selectedCount > 0 ? { paths: selectedPaths } : {}) },
      {
        onSuccess: (res) => {
          onCommitted?.()
          setSummary('')
          setDescription('')
          setAmend(false)
          saveDraft(repoPath, { summary: '', description: '' })
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
          title="Characters in the summary; aim for 50, keep it under 72"
        >
          {summary.length}
        </span>
      </div>
      {hint && (
        <p className="mt-1 text-xs text-warn" data-testid="summary-hint">
          {hint}
        </p>
      )}
      {(conventional || coAuthors.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
          {conventional && (
            <select
              aria-label="Commit type"
              value={currentType(summary) ?? ''}
              onChange={(e) => e.target.value && setSummary(applyType(summary, e.target.value))}
              className="rounded border border-border bg-bg px-1 py-0.5"
              title="This repository uses Conventional Commits"
            >
              <option value="">type…</option>
              {CONVENTIONAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          {coAuthors.length > 0 && (
            <button
              type="button"
              className="ml-auto rounded border border-border px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-fg"
              onClick={(e) =>
                openMenu(
                  e.clientX,
                  e.clientY,
                  coAuthors.map((p) => ({ label: `${p.name} <${p.email}>`, onSelect: () => setDescription((d) => addCoAuthor(d, p)) })),
                )
              }
            >
              Add co-author…
            </button>
          )}
        </div>
      )}
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
        className="w-full rounded bg-gradient-to-r from-accent to-accent-2 py-1.5 font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        {commit.isPending
          ? 'Committing…'
          : selectedCount > 0
            ? `${amend ? 'Amend with' : 'Commit'} ${selectedCount} selected file${selectedCount === 1 ? '' : 's'}`
            : amend
            ? 'Amend commit'
            : stagedCount > 0
              ? `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`
              : 'Stage files to commit'}
      </button>
    </form>
  )
}

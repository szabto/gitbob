import { Archive, ArchiveRestore, ArrowDownToLine, ArrowUpFromLine, ChevronDown, Command, FolderOpen, GitBranchPlus, RefreshCw, Redo2, Search, SquareTerminal, Undo2, X, type LucideIcon } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CommitSummary, GitRef, RepositoryInfo } from '@shared/types'
import { useHead, useHistory, useInvalidateRepo, useRefs, useStatus } from '../lib/queries'
import { call, subscribe } from '../lib/api'
import { groupStatus } from '../lib/status'
import { useAppStore } from '../state/store'
import { Sidebar } from './Sidebar'
import { ResizablePane } from './ResizeHandle'
import { CommitGraph } from './CommitGraph'
import { CommitDetailsPanel } from './CommitDetailsPanel'
import { MultiCommitPanel } from './MultiCommitPanel'
import { Logo } from './Welcome'
import { StagingPanel } from './StagingPanel'
import { DiffView } from './DiffView'
import { useRepoActions } from '../lib/actions'
import { useRemotes, useStashes, useUndoState } from '../lib/queries'
import { StashPanel } from './StashPanel'
import { OperationBanner } from './OperationBanner'
import { SpeedUpBanner } from './SpeedUpBanner'
import { FileHistoryView } from './FileHistoryView'
import { CompareView } from './CompareView'
import { DropHandler, makeDropHandler } from '../lib/dnd'
import { Picker } from './Picker'
import { commitMenu, localBranchMenu, remoteBranchMenu, tidy, type MenuContext } from '../lib/menus'
import { useHiddenRefs, useHiddenStore } from '../state/hidden'
import { BlameView } from './BlameView'
import { PullRequestView } from './PullRequestView'
import { RebaseDialog } from './RebaseDialog'
import { CreatePullRequestDialog, PROVIDER_NAMES } from './PullRequests'
import { useAppInfo, useProviderStatus, useRecent } from '../lib/queries'
import { displayPath } from '../lib/format'
import type { GitRef as GitRefType } from '@shared/types'
import { useUiStore, type MenuEntry } from '../state/ui'

// Monaco-based; loaded on first use.
const ConflictEditor = lazy(() => import('./ConflictEditor'))

interface Props {
  repo: RepositoryInfo
  onOpen: () => void
  onClose: () => void
  onClone?: () => void
  onInit?: () => void
}

const fileManagerName = navigator.platform.startsWith('Mac') ? 'Finder' : navigator.platform.startsWith('Win') ? 'Explorer' : 'file manager'

export function RepositoryView({ repo, onOpen, onClose, onClone, onInit }: Props) {
  const refs = useRefs(repo.root)
  const head = useHead(repo.root)
  const historyFilter = useAppStore((s) => s.historyFilter)
  const history = useHistory(repo.root, historyFilter)
  const status = useStatus(repo.root)
  const selectedSha = useAppStore((s) => s.selectedSha)
  const selectedShas = useAppStore((s) => s.selectedShas)
  const wipSelected = useAppStore((s) => s.wipSelected)
  const diffTarget = useAppStore((s) => s.diffTarget)
  const conflictPath = useAppStore((s) => s.conflictPath)
  const blame = useAppStore((s) => s.blame)
  const fileHistory = useAppStore((s) => s.fileHistory)
  const compareSha = useAppStore((s) => s.compareSha)
  const prNumber = useAppStore((s) => s.prNumber)
  const rebaseBase = useAppStore((s) => s.rebaseBase)
  const openRebase = useAppStore((s) => s.openRebase)
  const invalidate = useInvalidateRepo(repo.root)
  const queryClient = useQueryClient()

  // Refresh on filesystem changes (debounced in main) and when the window regains focus.
  useEffect(
    () =>
      subscribe('repo:changed', ({ repoPath }) => {
        if (repoPath === repo.root) invalidate({ history: false })
      }),
    [repo.root, invalidate],
  )
  useEffect(() => {
    const onFocus = (): void => invalidate({ history: false })
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [invalidate])

  // History only needs reloading when refs or HEAD actually moved.
  const refsFingerprint =
    refs.data && head.data ? JSON.stringify([head.data, refs.data.map((r) => [r.name, r.target])]) : null
  const lastFingerprint = useRef<string | null>(null)
  useEffect(() => {
    if (!refsFingerprint) return
    if (lastFingerprint.current !== null && lastFingerprint.current !== refsFingerprint) {
      void queryClient.invalidateQueries({ queryKey: ['log', repo.root] })
    }
    lastFingerprint.current = refsFingerprint
  }, [refsFingerprint, queryClient, repo.root])

  const changeCount = useMemo(() => {
    const g = groupStatus(status.data)
    let modified = 0
    let added = 0
    let deleted = 0
    for (const e of status.data?.entries ?? []) {
      if (e.kind === 'ignored') continue
      const codes = `${e.index}${e.worktree}`
      if (e.kind === 'untracked' || codes.includes('A')) added++
      else if (codes.includes('D')) deleted++
      else modified++
    }
    return { unstaged: g.unstaged.length + g.conflicted.length, staged: g.staged.length, modified, added, deleted }
  }, [status.data])

  const commits = useMemo(() => history.data?.pages.flatMap((p) => p.commits) ?? [], [history.data])
  // The multi-selection in graph order (newest first), as combining the changes expects.
  const selectedCommits = useMemo(() => {
    if (selectedShas.length < 2) return []
    const wanted = new Set(selectedShas)
    return commits.filter((c) => wanted.has(c.sha))
  }, [selectedShas, commits])

  const refsBySha = useMemo(() => {
    const map = new Map<string, GitRef[]>()
    for (const r of refs.data ?? []) {
      const list = map.get(r.target)
      if (list) list.push(r)
      else map.set(r.target, [r])
    }
    return map
  }, [refs.data])

  const actions = useRepoActions(repo.root)
  const undoState = useUndoState(repo.root)
  const remotes = useRemotes(repo.root)
  const busy = useUiStore((s) => s.busy)
  const progress = useUiStore((s) => s.progress)
  const openMenu = useUiStore((s) => s.openMenu)
  const currentRefObj = refs.data?.find((r) => r.name === head.data?.ref)
  const remoteNames = (remotes.data ?? []).map((r) => r.name)
  const stashes = useStashes(repo.root)
  const selectedStash = useAppStore((s) => s.selectedStash)
  const stashEntry = stashes.data?.find((s) => s.sha === selectedStash?.sha)
  const provider = useProviderStatus(repo.root)
  const appInfo = useAppInfo()
  const [prBranch, setPrBranch] = useState<GitRefType | null>(null)

  const currentBranch = head.data?.ref?.startsWith('refs/heads/') ? head.data.ref.slice('refs/heads/'.length) : null

  const tabs = useAppStore((s) => s.tabs)
  const setRepoInStore = useAppStore((s) => s.setRepo)
  const recent = useRecent()
  const showError = useUiStore((s) => s.showError)
  const openRecent = async (path: string): Promise<void> => {
    try {
      setRepoInStore(await call('repo:open', { path }))
    } catch (e) {
      showError(e)
    }
  }
  const openTerminal = async (): Promise<void> => {
    try {
      await call('repo:open-terminal', { repoPath: repo.root })
    } catch (e) {
      showError(e)
    }
  }

  const hiddenRefs = useHiddenRefs(repo.root)
  const toggleHidden = useHiddenStore((s) => s.toggle)
  const setHistoryFilter = useAppStore((s) => s.setHistoryFilter)
  const openCompare = useAppStore((s) => s.openCompare)
  const commitBySha = useMemo(() => new Map(commits.map((c) => [c.sha, c])), [commits])
  // Ancestors of HEAD among the loaded commits, computed on first use per HEAD / page set.
  // Keyed on HEAD and the commit list itself: a rewrite can change commits without changing their count.
  const ancestors = useRef<{ head: string; commits: CommitSummary[]; set: Set<string> } | null>(null)
  const onCurrentBranch = (sha: string): boolean => {
    const headSha = head.data?.sha
    if (!headSha) return false
    if (ancestors.current?.head !== headSha || ancestors.current.commits !== commits) {
      const set = new Set<string>()
      const stack = [headSha]
      while (stack.length) {
        const s = stack.pop()!
        if (set.has(s)) continue
        set.add(s)
        for (const p of commitBySha.get(s)?.parents ?? []) stack.push(p)
      }
      ancestors.current = { head: headSha, commits, set }
    }
    return ancestors.current.set.has(sha)
  }
  const menuCtx: MenuContext = {
    actions,
    bare: repo.bare,
    headSha: head.data?.sha ?? null,
    currentRef: head.data?.ref?.startsWith('refs/heads/') ? head.data.ref : null,
    refs: refs.data ?? [],
    remotes: remotes.data ?? [],
    provider: provider.data ?? null,
    hidden: hiddenRefs,
    onCurrentBranch,
    openRebase,
    openCompare,
    setHistoryFilter,
    toggleHidden: (ref) => toggleHidden(repo.root, ref),
    onCreatePullRequest: setPrBranch,
  }
  const commitFor = (sha: string): CommitSummary =>
    commitBySha.get(sha) ?? { sha, parents: [], authorName: '', authorEmail: '', authorTime: 0, committerName: '', committerEmail: '', commitTime: 0, subject: sha.slice(0, 7) }
  const refMenu = (ref: GitRef): MenuEntry[] => {
    const commit = commitFor(ref.target)
    if (ref.kind === 'head') return tidy(localBranchMenu(menuCtx, ref, commit))
    if (ref.kind === 'remote') return tidy(remoteBranchMenu(menuCtx, ref, commit))
    return tidy(commitMenu(menuCtx, commit))
  }

  const dropHandler = makeDropHandler({ currentRef: head.data?.ref ?? null, actions }, openMenu)
  return (
    <DropHandler.Provider value={dropHandler}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
          <Logo size={22} />
          <Picker
            label="Switch repository"
            testId="repo-picker"
            placeholder="Find a repository"
            buttonContent={
              <span className="font-semibold" data-testid="repo-name">
                {repo.name}
              </span>
            }
            items={[
              ...tabs.map((t) => ({ key: `tab:${t.root}`, label: t.name, hint: 'open', group: 'Open tabs', current: t.root === repo.root, onSelect: () => setRepoInStore(t) })),
              ...(recent.data ?? [])
                .filter((r) => !tabs.some((t) => t.root === r.path))
                .map((r) => ({ key: `recent:${r.path}`, label: r.name, hint: displayPath(r.path, appInfo.data?.home), group: 'Recent', onSelect: () => void openRecent(r.path) })),
            ]}
            footer={[
              { key: 'open', label: 'Open repository…', onSelect: onOpen },
              ...(onClone ? [{ key: 'clone', label: 'Clone…', onSelect: onClone }] : []),
              ...(onInit ? [{ key: 'init', label: 'New repository…', onSelect: onInit }] : []),
              { key: 'terminal', label: 'Open in terminal', onSelect: () => void openTerminal() },
              { key: 'reveal', label: `Show in ${fileManagerName}`, onSelect: () => void call('repo:reveal', { repoPath: repo.root }).catch(showError) },
            ]}
          />
          <span className="truncate text-xs text-muted" title={repo.root} data-testid="repo-path">
            {displayPath(repo.root, appInfo.data?.home)}
          </span>
          <Picker
            label="Switch branch"
            testId="branch-picker"
            placeholder="Find a branch"
            buttonContent={
              <span className="rounded bg-panel-2 px-2 py-0.5 text-xs" data-testid="head-label">
                {head.data
                  ? head.data.detached
                    ? `HEAD detached at ${head.data.sha?.slice(0, 7) ?? '?'}`
                    : `${currentBranch ?? head.data.ref}${head.data.unborn ? ' (no commits)' : ''}`
                  : '…'}
              </span>
            }
            items={[
              ...(refs.data ?? [])
                .filter((r) => r.kind === 'head')
                .map((r) => ({
                  key: r.name,
                  label: r.shortName,
                  group: 'Local',
                  current: r.name === head.data?.ref,
                  ...(r.upstream && (r.ahead || r.behind) ? { hint: `↑${r.ahead ?? 0} ↓${r.behind ?? 0}` } : {}),
                  onSelect: () => r.name !== head.data?.ref && void actions.checkout(r.name),
                })),
              ...(refs.data ?? [])
                .filter((r) => r.kind === 'remote' && !r.name.endsWith('/HEAD'))
                .map((r) => ({ key: r.name, label: r.shortName, group: 'Remote', onSelect: () => void actions.checkout(r.name) })),
            ]}
            footer={head.data?.sha ? [{ key: 'create', label: 'Create branch…', onSelect: () => void actions.createBranch(head.data!.sha!) }] : []}
          />
          {currentRefObj?.upstream && (
            <span className="shrink-0 text-xs whitespace-nowrap text-muted" data-testid="tracking-status" title={currentRefObj.upstream}>
              {currentRefObj.upstreamGone
                ? 'upstream gone'
                : `↑${currentRefObj.ahead ?? 0} ↓${currentRefObj.behind ?? 0}`}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5" data-testid="toolbar">
            {busy && (
              <span className="mr-2 flex items-center gap-2 text-xs text-accent" data-testid="busy">
                <span className="animate-pulse">
                  {busy}
                  {progress ? ` ${progress.phase} ${progress.percent}%` : ''}
                </span>
                {progress && (
                  <span className="h-1 w-20 overflow-hidden rounded bg-panel-2">
                    <span
                      className="block h-full bg-gradient-to-r from-accent to-accent-2"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </span>
                )}
                <button
                  className="rounded border border-border px-1.5 text-muted hover:text-fg"
                  onClick={() => void call('op:cancel', {})}
                >
                  Cancel
                </button>
              </span>
            )}
            {!repo.bare && (
              <>
                <ToolbarButton
                  label="Undo"
                  icon={Undo2}
                  title={undoState.data?.undo ? `Undo: ${undoState.data.undo}` : 'Nothing to undo'}
                  disabled={!!busy || !undoState.data?.undo}
                  onClick={() => void actions.undo()}
                />
                <ToolbarButton
                  label="Redo"
                  icon={Redo2}
                  title={undoState.data?.redo ? `Redo: ${undoState.data.redo}` : 'Nothing to redo'}
                  disabled={!!busy || !undoState.data?.redo}
                  onClick={() => void actions.redo()}
                />
                <span className="mx-1 h-5 border-l border-border" />
                <ToolbarButton label="Fetch"
                  icon={RefreshCw} disabled={!!busy || remoteNames.length === 0} onClick={() => void actions.fetch()} />
                <ToolbarButton
                  label="Pull"
                  icon={ArrowDownToLine}
                  disabled={!!busy || !currentRefObj?.upstream}
                  onClick={() => void actions.pull('ff-only')}
                  onMenu={(e) =>
                    openMenu(e.clientX, e.clientY, [
                      { label: 'Pull (fast-forward only)', onSelect: () => void actions.pull('ff-only') },
                      { label: 'Pull (merge)', onSelect: () => void actions.pull('merge') },
                      { label: 'Pull (rebase)', onSelect: () => void actions.pull('rebase') },
                    ])
                  }
                />
                <ToolbarButton
                  label="Push"
                  icon={ArrowUpFromLine}
                  disabled={!!busy || !currentRefObj}
                  onClick={() => void actions.push(currentRefObj, remoteNames)}
                />
                <ToolbarButton
                  label="Branch"
                  icon={GitBranchPlus}
                  disabled={!head.data?.sha}
                  onClick={() => head.data?.sha && void actions.createBranch(head.data.sha)}
                />
                <ToolbarButton
                  label="Stash"
                  icon={Archive}
                  title="Stash all changes"
                  disabled={!!busy || !head.data?.sha || changeCount.unstaged + changeCount.staged === 0}
                  onClick={() => void actions.stash()}
                />
                <ToolbarButton
                  label="Pop"
                  icon={ArchiveRestore}
                  title={stashes.data?.[0] ? `Pop the latest stash: ${stashes.data[0].message}` : 'No stashes'}
                  disabled={!!busy || !stashes.data?.length}
                  onClick={() => stashes.data?.[0] && void actions.applyStash(stashes.data[0], true)}
                />
                <span className="mx-1 h-5 border-l border-border" />
                <ToolbarButton label="Terminal"
                  icon={SquareTerminal} title="Open a terminal in this repository" onClick={() => void openTerminal()} />
                <ToolbarButton
                  label="Search"
                  icon={Search}
                  title="Search the history"
                  onClick={() => {
                    const el = document.getElementById('graph-search-input') as HTMLInputElement | null
                    el?.focus()
                    el?.select()
                  }}
                />
                <ToolbarButton label="Actions"
                  icon={Command} title="All commands" onClick={() => window.dispatchEvent(new Event('gitbob:command-palette'))} />
                <span className="mx-1 h-5 border-l border-border" />
              </>
            )}
            <ToolbarButton label="Open…" icon={FolderOpen} onClick={onOpen} />
            <ToolbarButton label="Close" icon={X} onClick={onClose} />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <ResizablePane pane="sidebar" label="Resize sidebar" testId="sidebar-pane">
            <Sidebar
              refs={refs.data ?? []}
              currentRef={head.data?.ref ?? null}
              remotes={remoteNames}
              stashes={stashes.data ?? []}
              actions={actions}
              repoPath={repo.root}
              currentBranch={currentBranch}
              provider={provider.data ?? null}
              refMenu={refMenu}
            />
          </ResizablePane>
          <main className="flex min-w-0 flex-1 flex-col">
            {status.data && <OperationBanner status={status.data} actions={actions} />}
            <SpeedUpBanner repoPath={repo.root} historyLoaded={!!history.data} />
            {prNumber && provider.data?.repo && !diffTarget ? (
              <PullRequestView repoPath={repo.root} number={prNumber} providerName={PROVIDER_NAMES[provider.data.repo.kind]} />
            ) : compareSha ? (
            <CompareView key={compareSha} repoPath={repo.root} sha={compareSha} />
          ) : fileHistory ? (
              <FileHistoryView key={fileHistory} repoPath={repo.root} path={fileHistory} />
            ) : blame ? (
              <BlameView repoPath={repo.root} path={blame.path} {...(blame.rev ? { rev: blame.rev } : {})} />
            ) : conflictPath ? (
              <Suspense fallback={<div className="p-4 text-xs text-muted">Loading editor…</div>}>
                <ConflictEditor repoPath={repo.root} path={conflictPath} />
              </Suspense>
            ) : diffTarget ? (
              <DiffView repoPath={repo.root} target={diffTarget} />
            ) : history.isError ? (
              <div className="p-6 text-danger">Failed to load history: {history.error.message}</div>
            ) : history.isPending ? (
              <div className="p-6 text-muted">Loading history…</div>
            ) : commits.length === 0 && historyFilter ? (
              <FilteredEmpty />
            ) : commits.length === 0 && changeCount.unstaged + changeCount.staged === 0 ? (
              <div className="p-6 text-muted" data-testid="empty-history">
                This repository has no commits yet.
              </div>
            ) : (
              <CommitGraph
                repoPath={repo.root}
                commits={commits}
                headSha={head.data?.sha ?? null}
                currentRef={head.data?.ref ?? null}
                hasMore={!!history.hasNextPage}
                loadingMore={history.isFetchingNextPage}
                onLoadMore={() => void history.fetchNextPage()}
                wip={repo.bare || historyFilter ? null : changeCount}
                refs={refs.data ?? []}
                onRowMenu={(e, commit) => openMenu(e.clientX, e.clientY, tidy(commitMenu(menuCtx, commit)))}
                onRefMenu={(e, ref) => openMenu(e.clientX, e.clientY, refMenu(ref))}
              />
            )}
          </main>
          {prBranch && provider.data?.repo && (
            <CreatePullRequestDialog
              repoPath={repo.root}
              providerName={PROVIDER_NAMES[provider.data.repo.kind]}
              branch={prBranch.shortName}
              targets={(refs.data ?? [])
                .filter((r) => r.kind === 'remote' && r.shortName.startsWith(`${provider.data!.remote}/`))
                .map((r) => r.shortName.slice(provider.data!.remote!.length + 1))
                .filter((b) => b !== prBranch.shortName)}
              defaultTitle={commits.find((c) => c.sha === prBranch.target)?.subject ?? prBranch.shortName}
              onClose={() => setPrBranch(null)}
            />
          )}
          {rebaseBase && <RebaseDialog repoPath={repo.root} base={rebaseBase} onClose={() => openRebase(null)} />}
          {((wipSelected && !repo.bare) || stashEntry || selectedSha || selectedCommits.length > 1) && (
            <ResizablePane pane="details" label="Resize details panel" testId="details-pane">
              {wipSelected && !repo.bare ? (
                <StagingPanel repo={repo} onStash={() => void actions.stash()} onStashFiles={(paths) => void actions.stashFiles(paths)} />
              ) : stashEntry ? (
                <StashPanel repoPath={repo.root} stash={stashEntry} actions={actions} />
              ) : selectedCommits.length > 1 ? (
                <MultiCommitPanel key={selectedCommits.map((c) => c.sha).join()} repoPath={repo.root} commits={selectedCommits} />
              ) : (
                selectedSha && <CommitDetailsPanel repoPath={repo.root} sha={selectedSha} refsBySha={refsBySha} />
              )}
            </ResizablePane>
          )}
        </div>
      </div>
    </DropHandler.Provider>
  )
}

function ToolbarButton({
  label,
  icon: Icon,
  onClick,
  onMenu,
  disabled,
  title,
}: {
  label: string
  icon: LucideIcon
  title?: string
  onClick: () => void
  onMenu?: (e: React.MouseEvent) => void
  disabled?: boolean
}) {
  return (
    <span className="inline-flex items-stretch">
      <button
        disabled={disabled}
        onClick={onClick}
        title={title}
        className="flex min-w-11 flex-col items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent"
      >
        <Icon size={17} strokeWidth={1.75} aria-hidden />
        <span>{label}</span>
      </button>
      {onMenu && (
        <button
          disabled={disabled}
          aria-label={`${label} options`}
          onClick={(e) => {
            e.stopPropagation()
            onMenu(e)
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="-ml-1 rounded px-0.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-35"
        >
          <ChevronDown size={12} aria-hidden />
        </button>
      )}
    </span>
  )
}

function FilteredEmpty() {
  const setHistoryFilter = useAppStore((s) => s.setHistoryFilter)
  return (
    <div className="p-6 text-muted" data-testid="filtered-empty">
      No commits match the filter.{' '}
      <button className="text-accent hover:underline" onClick={() => setHistoryFilter(null)}>
        Clear filter
      </button>
    </div>
  )
}

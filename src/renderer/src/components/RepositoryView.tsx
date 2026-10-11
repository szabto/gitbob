import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { GitRef, RepositoryInfo } from '@shared/types'
import { useHead, useHistory, useInvalidateRepo, useRefs, useStatus } from '../lib/queries'
import { call, subscribe } from '../lib/api'
import { groupStatus } from '../lib/status'
import { useAppStore } from '../state/store'
import { Sidebar } from './Sidebar'
import { CommitGraph } from './CommitGraph'
import { CommitDetailsPanel } from './CommitDetailsPanel'
import { Logo } from './Welcome'
import { StagingPanel } from './StagingPanel'
import { DiffView } from './DiffView'
import { useRepoActions } from '../lib/actions'
import { useRemotes, useStashes, useUndoState } from '../lib/queries'
import { StashPanel } from './StashPanel'
import { OperationBanner } from './OperationBanner'
import { SpeedUpBanner } from './SpeedUpBanner'
import { FileHistoryView } from './FileHistoryView'
import { DropHandler, makeDropHandler } from '../lib/dnd'
import { BlameView } from './BlameView'
import { PullRequestView } from './PullRequestView'
import { RebaseDialog } from './RebaseDialog'
import { CreatePullRequestDialog, PROVIDER_NAMES } from './PullRequests'
import { useAppInfo, useProviderStatus } from '../lib/queries'
import { displayPath } from '../lib/format'
import type { GitRef as GitRefType } from '@shared/types'
import { useUiStore } from '../state/ui'

// Monaco-based; loaded on first use.
const ConflictEditor = lazy(() => import('./ConflictEditor'))

interface Props {
  repo: RepositoryInfo
  onOpen: () => void
  onClose: () => void
}

export function RepositoryView({ repo, onOpen, onClose }: Props) {
  const refs = useRefs(repo.root)
  const head = useHead(repo.root)
  const historyFilter = useAppStore((s) => s.historyFilter)
  const history = useHistory(repo.root, historyFilter)
  const status = useStatus(repo.root)
  const selectedSha = useAppStore((s) => s.selectedSha)
  const wipSelected = useAppStore((s) => s.wipSelected)
  const diffTarget = useAppStore((s) => s.diffTarget)
  const conflictPath = useAppStore((s) => s.conflictPath)
  const blame = useAppStore((s) => s.blame)
  const fileHistory = useAppStore((s) => s.fileHistory)
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
    return { unstaged: g.unstaged.length + g.conflicted.length, staged: g.staged.length }
  }, [status.data])

  const commits = useMemo(() => history.data?.pages.flatMap((p) => p.commits) ?? [], [history.data])

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
  const branchLabel = currentBranchName(head.data?.ref ?? null)
  const provider = useProviderStatus(repo.root)
  const appInfo = useAppInfo()
  const [prBranch, setPrBranch] = useState<GitRefType | null>(null)

  const currentBranch = head.data?.ref?.startsWith('refs/heads/') ? head.data.ref.slice('refs/heads/'.length) : null

  const dropHandler = makeDropHandler({ currentRef: head.data?.ref ?? null, actions }, openMenu)
  return (
    <DropHandler.Provider value={dropHandler}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
          <Logo size={22} />
          <span className="font-semibold" data-testid="repo-name">
            {repo.name}
          </span>
          <span className="truncate text-xs text-muted" title={repo.root} data-testid="repo-path">
            {displayPath(repo.root, appInfo.data?.home)}
          </span>
          <span className="ml-2 rounded bg-panel-2 px-2 py-0.5 text-xs" data-testid="head-label">
            {head.data
              ? head.data.detached
                ? `HEAD detached at ${head.data.sha?.slice(0, 7) ?? '?'}`
                : `${currentBranch ?? head.data.ref}${head.data.unborn ? ' (no commits)' : ''}`
              : '…'}
          </span>
          {currentRefObj?.upstream && (
            <span className="text-xs text-muted" data-testid="tracking-status" title={currentRefObj.upstream}>
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
                  title={undoState.data?.undo ? `Undo: ${undoState.data.undo}` : 'Nothing to undo'}
                  disabled={!!busy || !undoState.data?.undo}
                  onClick={() => void actions.undo()}
                />
                <ToolbarButton
                  label="Redo"
                  title={undoState.data?.redo ? `Redo: ${undoState.data.redo}` : 'Nothing to redo'}
                  disabled={!!busy || !undoState.data?.redo}
                  onClick={() => void actions.redo()}
                />
                <span className="mx-1 h-5 border-l border-border" />
                <ToolbarButton label="Fetch" disabled={!!busy || remoteNames.length === 0} onClick={() => void actions.fetch()} />
                <ToolbarButton
                  label="Pull"
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
                  disabled={!!busy || !currentRefObj}
                  onClick={() => void actions.push(currentRefObj, remoteNames)}
                />
                <ToolbarButton
                  label="Branch"
                  disabled={!head.data?.sha}
                  onClick={() => head.data?.sha && void actions.createBranch(head.data.sha)}
                />
                <span className="mx-1 h-5 border-l border-border" />
              </>
            )}
            <button className="rounded border border-border px-2.5 py-1 hover:bg-panel-2" onClick={onOpen}>
              Open…
            </button>
            <button className="rounded border border-border px-2.5 py-1 hover:bg-panel-2" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <Sidebar
            refs={refs.data ?? []}
            currentRef={head.data?.ref ?? null}
            remotes={remoteNames}
            stashes={stashes.data ?? []}
            actions={actions}
            repoPath={repo.root}
            currentBranch={currentBranch}
            provider={provider.data ?? null}
            onCreatePullRequest={setPrBranch}
          />
          <main className="flex min-w-0 flex-1 flex-col">
            {status.data && <OperationBanner status={status.data} actions={actions} />}
            <SpeedUpBanner repoPath={repo.root} historyLoaded={!!history.data} />
            {prNumber && provider.data?.repo && !diffTarget ? (
              <PullRequestView repoPath={repo.root} number={prNumber} providerName={PROVIDER_NAMES[provider.data.repo.kind]} />
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
                refsBySha={refsBySha}
                headSha={head.data?.sha ?? null}
                currentRef={head.data?.ref ?? null}
                hasMore={!!history.hasNextPage}
                loadingMore={history.isFetchingNextPage}
                onLoadMore={() => void history.fetchNextPage()}
                wip={repo.bare || historyFilter ? null : changeCount}
                refs={refs.data ?? []}
                onRowMenu={(e, commit) =>
                  openMenu(e.clientX, e.clientY, [
                    { label: 'Create branch here…', onSelect: () => void actions.createBranch(commit.sha) },
                    { label: 'Create tag here…', onSelect: () => void actions.createTag(commit.sha) },
                    'separator',
                    {
                      label: 'Cherry-pick this commit',
                      disabled: repo.bare || commit.sha === head.data?.sha,
                      onSelect: () => void actions.cherryPick(commit.sha),
                    },
                    { label: 'Revert this commit', disabled: repo.bare, onSelect: () => void actions.revert(commit.sha) },
                    {
                      label: `Interactive rebase ${branchLabel} onto here…`,
                      disabled: repo.bare || !head.data?.ref || commit.sha === head.data?.sha,
                      onSelect: () => openRebase(commit.sha),
                    },
                    ...(head.data?.sha && !repo.bare
                      ? ([
                          'separator',
                          {
                            label: `Reset ${branchLabel} to here (soft: keep changes staged)`,
                            onSelect: () => void actions.reset(commit.sha, 'soft'),
                          },
                          {
                            label: `Reset ${branchLabel} to here (mixed: keep changes unstaged)`,
                            onSelect: () => void actions.reset(commit.sha, 'mixed'),
                          },
                          {
                            label: `Reset ${branchLabel} to here (hard: discard changes)…`,
                            danger: true,
                            onSelect: () => void actions.reset(commit.sha, 'hard'),
                          },
                        ] as const)
                      : []),
                    {
                      label: 'Checkout this commit (detached)',
                      disabled: repo.bare,
                      onSelect: () => void actions.checkoutCommit(commit.sha),
                    },
                    'separator',
                    { label: 'Copy commit SHA', onSelect: () => void navigator.clipboard.writeText(commit.sha) },
                  ])
                }
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
          {wipSelected && !repo.bare ? (
            <StagingPanel repo={repo} onStash={() => void actions.stash()} />
          ) : stashEntry ? (
            <StashPanel repoPath={repo.root} stash={stashEntry} actions={actions} />
          ) : (
            selectedSha && <CommitDetailsPanel repoPath={repo.root} sha={selectedSha} refsBySha={refsBySha} />
          )}
        </div>
      </div>
    </DropHandler.Provider>
  )
}

function ToolbarButton({
  label,
  onClick,
  onMenu,
  disabled,
  title,
}: {
  label: string
  title?: string
  onClick: () => void
  onMenu?: (e: React.MouseEvent) => void
  disabled?: boolean
}) {
  return (
    <span className="inline-flex">
      <button
        disabled={disabled}
        onClick={onClick}
        title={title}
        className={`border border-border px-2.5 py-1 hover:bg-panel-2 disabled:opacity-40 ${
          onMenu ? 'rounded-l border-r-0' : 'rounded'
        }`}
      >
        {label}
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
          className="rounded-r border border-border px-1.5 py-1 text-muted hover:bg-panel-2 disabled:opacity-40"
        >
          ▾
        </button>
      )}
    </span>
  )
}

function currentBranchName(ref: string | null): string {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : 'HEAD'
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

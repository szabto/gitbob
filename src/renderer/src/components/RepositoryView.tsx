import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { GitRef, RepositoryInfo } from '@shared/types'
import { useHead, useHistory, useInvalidateRepo, useRefs, useStatus } from '../lib/queries'
import { subscribe } from '../lib/api'
import { groupStatus } from '../lib/status'
import { useAppStore } from '../state/store'
import { Sidebar } from './Sidebar'
import { CommitGraph } from './CommitGraph'
import { CommitDetailsPanel } from './CommitDetailsPanel'
import { Logo } from './Welcome'
import { StagingPanel } from './StagingPanel'
import { DiffView } from './DiffView'
import { useRepoActions } from '../lib/actions'
import { useRemotes } from '../lib/queries'
import { useUiStore } from '../state/ui'

interface Props {
  repo: RepositoryInfo
  onOpen: () => void
  onClose: () => void
}

export function RepositoryView({ repo, onOpen, onClose }: Props) {
  const refs = useRefs(repo.root)
  const head = useHead(repo.root)
  const history = useHistory(repo.root)
  const status = useStatus(repo.root)
  const selectedSha = useAppStore((s) => s.selectedSha)
  const wipSelected = useAppStore((s) => s.wipSelected)
  const diffTarget = useAppStore((s) => s.diffTarget)
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
  const remotes = useRemotes(repo.root)
  const busy = useUiStore((s) => s.busy)
  const openMenu = useUiStore((s) => s.openMenu)
  const currentRefObj = refs.data?.find((r) => r.name === head.data?.ref)
  const remoteNames = (remotes.data ?? []).map((r) => r.name)

  const currentBranch = head.data?.ref?.startsWith('refs/heads/') ? head.data.ref.slice('refs/heads/'.length) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
        <Logo size={22} />
        <span className="font-semibold" data-testid="repo-name">
          {repo.name}
        </span>
        <span className="truncate text-xs text-muted" title={repo.root}>
          {repo.root}
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
          {busy && <span className="mr-2 animate-pulse text-xs text-accent" data-testid="busy">{busy}</span>}
          {!repo.bare && (
            <>
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
          actions={actions}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {diffTarget ? (
            <DiffView repoPath={repo.root} target={diffTarget} />
          ) : history.isError ? (
            <div className="p-6 text-danger">Failed to load history: {history.error.message}</div>
          ) : history.isPending ? (
            <div className="p-6 text-muted">Loading history…</div>
          ) : commits.length === 0 && changeCount.unstaged + changeCount.staged === 0 ? (
            <div className="p-6 text-muted" data-testid="empty-history">
              This repository has no commits yet.
            </div>
          ) : (
            <CommitGraph
              commits={commits}
              refsBySha={refsBySha}
              headSha={head.data?.sha ?? null}
              currentRef={head.data?.ref ?? null}
              hasMore={!!history.hasNextPage}
              loadingMore={history.isFetchingNextPage}
              onLoadMore={() => void history.fetchNextPage()}
              wip={repo.bare ? null : changeCount}
              onRowMenu={(e, commit) =>
                openMenu(e.clientX, e.clientY, [
                  { label: 'Create branch here…', onSelect: () => void actions.createBranch(commit.sha) },
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
        {wipSelected && !repo.bare ? (
          <StagingPanel repo={repo} />
        ) : (
          selectedSha && <CommitDetailsPanel repoPath={repo.root} sha={selectedSha} refsBySha={refsBySha} />
        )}
      </div>
    </div>
  )
}

function ToolbarButton({
  label,
  onClick,
  onMenu,
  disabled,
}: {
  label: string
  onClick: () => void
  onMenu?: (e: React.MouseEvent) => void
  disabled?: boolean
}) {
  return (
    <span className="inline-flex">
      <button
        disabled={disabled}
        onClick={onClick}
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

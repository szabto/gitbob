import { useEffect, useState } from 'react'
import { useHiddenRefs, useHiddenStore } from '../state/hidden'
import { IssuesSection } from './IssuesSection'
import { useSectionOpen } from '../lib/sidebar-sections'
import { isMac } from '../lib/shortcuts'
import { endDrag, startDrag, useDropTarget } from '../lib/dnd'
import { useReflog, useSubmodules, useWorktrees } from '../lib/queries'
import { formatShortDate, shortSha } from '../lib/format'
import type { GitRef, ProviderStatus, StashEntry } from '@shared/types'
import { PullRequestsSection } from './PullRequests'
import { RefTree } from './RefTree'
import { LfsSection } from './LfsSection'
import { useAppStore } from '../state/store'
import { useUiStore, type MenuEntry } from '../state/ui'
import type { useRepoActions } from '../lib/actions'

type Actions = ReturnType<typeof useRepoActions>

export function Sidebar({
  refs,
  currentRef,
  remotes,
  stashes,
  actions,
  repoPath,
  currentBranch,
  provider,
  onCreatePullRequest,
}: {
  refs: GitRef[]
  currentRef: string | null
  remotes: string[]
  stashes: StashEntry[]
  actions: Actions
  repoPath: string
  currentBranch: string | null
  provider: ProviderStatus | null
  onCreatePullRequest: (branch: GitRef) => void
}) {
  const selectStash = useAppStore((s) => s.selectStash)
  const selectedStash = useAppStore((s) => s.selectedStash)
  const reveal = useAppStore((s) => s.reveal)
  const openMenu = useUiStore((s) => s.openMenu)
  const [query, setQuery] = useState('')
  const hidden = useHiddenRefs(repoPath)
  const toggleHidden = useHiddenStore((s) => s.toggle)
  const showAll = useHiddenStore((s) => s.showAll)
  const q = query.trim().toLowerCase()
  const match = (r: GitRef): boolean => !q || r.shortName.toLowerCase().includes(q)
  const graphRefs = refs.filter((r) => r.kind === 'head' || (r.kind === 'remote' && !r.name.endsWith('/HEAD')) || r.kind === 'tag')
  const hiddenCount = graphRefs.filter((r) => hidden.includes(r.name)).length
  const hideProps = (r: GitRef) =>
    r.name === currentRef ? {} : { hidden: hidden.includes(r.name), onToggleHidden: () => toggleHidden(repoPath, r.name) }
  const local = refs.filter((r) => r.kind === 'head' && match(r))
  const remote = refs.filter((r) => r.kind === 'remote' && match(r))
  const tags = refs.filter((r) => r.kind === 'tag' && match(r))
  const filtering = q.length > 0
  // ⌥⌘F / Ctrl+Alt+F focuses the branch filter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && (isMac ? e.metaKey : e.ctrlKey) && e.code === 'KeyF') {
        e.preventDefault()
        document.getElementById('sidebar-filter')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const remoteBranchNames = remote.map((r) => r.shortName)

  const mergeEntries = (r: GitRef): MenuEntry[] =>
    currentBranch && r.name !== currentRef
      ? [
          { label: `Merge ${r.shortName} into ${currentBranch}`, onSelect: () => void actions.merge(r) },
          { label: `Rebase ${currentBranch} onto ${r.shortName}…`, onSelect: () => void actions.rebase(r) },
        ]
      : []

  const localMenu = (r: GitRef): MenuEntry[] => [
    { label: `Checkout ${r.shortName}`, disabled: r.name === currentRef, onSelect: () => void actions.checkout(r.name) },
    { label: 'Create branch here…', onSelect: () => void actions.createBranch(r.target) },
    ...mergeEntries(r),
    'separator',
    { label: 'Rename…', onSelect: () => void actions.rename(r.shortName) },
    r.upstream
      ? { label: 'Unset upstream', onSelect: () => void actions.unsetUpstream(r.shortName) }
      : { label: 'Set upstream…', onSelect: () => void actions.setUpstream(r.shortName, remoteBranchNames) },
    ...(provider?.connected && r.upstream?.startsWith(`refs/remotes/${provider.remote}/`)
      ? [{ label: 'Create pull request…', onSelect: () => onCreatePullRequest(r) }]
      : []),
    ...(r.upstream
      ? [
          {
            label: 'Force push (with lease)…',
            onSelect: () => void actions.forcePush(r, r.upstream!.replace(/^refs\/remotes\/([^/]+)\/.*$/, '$1')),
          },
        ]
      : []),
    'separator',
    {
      label: `Delete ${r.shortName}…`,
      danger: true,
      disabled: r.name === currentRef,
      onSelect: () => void actions.deleteBranch(r.shortName),
    },
  ]

  const remoteMenu = (r: GitRef): MenuEntry[] => [
    { label: `Checkout ${r.shortName}`, onSelect: () => void actions.checkout(r.name) },
    { label: 'Create branch here…', onSelect: () => void actions.createBranch(r.target) },
    ...mergeEntries(r),
  ]

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-panel py-2" data-testid="sidebar">
      <div className="mb-1 px-3" style={{ order: -1 }}>
        <div className="mb-1 flex items-center text-xs text-muted" data-testid="viewing">
          <span>
            Viewing {graphRefs.length - hiddenCount}/{graphRefs.length}
          </span>
          {hiddenCount > 0 && (
            <button className="ml-auto text-accent hover:underline" onClick={() => showAll(repoPath)}>
              Show all
            </button>
          )}
        </div>
        <input
          id="sidebar-filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          placeholder={`Filter (${isMac ? '⌥⌘F' : 'Ctrl+Alt+F'})`}
          aria-label="Filter branches and tags"
          className="w-full rounded border border-border bg-bg px-2 py-0.5 text-xs outline-none focus:border-accent"
        />
      </div>
      {/* Spacer: open sections above, collapsed ones docked below. */}
      <div className="flex-1" style={{ order: 1 }} />
      <Section title="Local" count={local.length} testId="local-branches" {...(filtering ? { open: true, onToggle: () => {} } : {})}>
        <RefTree
          refs={local}
          scope="local"
          activeRef={currentRef}
          renderRef={(r, label, depth) => (
            <RefItem
              key={r.name}
              gitRef={r}
              label={label}
              depth={depth}
              active={r.name === currentRef}
              onClick={() => reveal(r.target)}
              onDoubleClick={() => r.name !== currentRef && void actions.checkout(r.name)}
              onMenu={(e) => openMenu(e.clientX, e.clientY, localMenu(r))}
              {...hideProps(r)}
            />
          )}
        />
      </Section>
      {provider?.repo && (
        <PullRequestsSection repoPath={repoPath} status={provider} remoteRefs={remote} actions={actions} />
      )}
      {provider?.repo && <IssuesSection repoPath={repoPath} status={provider} />}
      <Section
        title="Remote"
        count={remote.length}
        testId="remote-branches"
        action={{ label: '+', title: 'Add remote', onClick: () => void actions.addRemote() }}
        {...(filtering ? { open: true, onToggle: () => {} } : {})}
      >
        {remotes.map((name) => (
          <RemoteGroup
            key={`remote:${name}`}
            name={name}
            refs={remote.filter((r) => r.shortName.startsWith(`${name}/`))}
            onMenu={(e) =>
              openMenu(e.clientX, e.clientY, [
                { label: 'Fetch', onSelect: () => void actions.fetch() },
                { label: `Remove remote ${name}…`, danger: true, onSelect: () => void actions.removeRemote(name) },
              ])
            }
            renderRef={(r, label, depth) => (
              <RefItem
                key={r.name}
                gitRef={r}
                label={label}
                depth={depth}
                active={false}
                onClick={() => reveal(r.target)}
                onDoubleClick={() => void actions.checkout(r.name)}
                onMenu={(e) => openMenu(e.clientX, e.clientY, remoteMenu(r))}
                {...hideProps(r)}
              />
            )}
          />
        ))}
      </Section>
      <Section title="Tags" count={tags.length} testId="tags" {...(filtering ? { open: true, onToggle: () => {} } : {})}>
        <RefTree
          refs={tags}
          scope="tags"
          renderRef={(r, label, depth) => (
          <RefItem
            key={r.name}
            gitRef={r}
            label={label}
            depth={depth}
            active={false}
            onClick={() => reveal(r.target)}
            onMenu={(e) =>
              openMenu(e.clientX, e.clientY, [
                { label: `Push tag ${r.shortName}…`, onSelect: () => void actions.pushTag(r.shortName, remotes) },
                'separator',
                { label: `Delete tag ${r.shortName}…`, danger: true, onSelect: () => void actions.deleteTag(r.shortName) },
              ])
            }
            {...hideProps(r)}
          />
          )}
        />
      </Section>
      <Section title="Stashes" count={stashes.length} testId="stashes">
        {stashes.map((s) => (
          <li key={s.sha}>
            <button
              data-testid="stash-item"
              title={s.message}
              onClick={() => selectStash({ index: s.index, sha: s.sha })}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(e.clientX, e.clientY, [
                  { label: 'Pop (apply and delete)', onSelect: () => void actions.applyStash(s, true) },
                  { label: 'Apply', onSelect: () => void actions.applyStash(s, false) },
                  'separator',
                  { label: 'Delete…', danger: true, onSelect: () => void actions.dropStash(s) },
                ])
              }}
              className={`flex w-full items-center gap-2 truncate py-0.5 pr-3 pl-7 text-left hover:bg-panel-2 ${
                selectedStash?.sha === s.sha ? 'bg-accent/20' : ''
              }`}
            >
              <span className="truncate">{s.message}</span>
            </button>
          </li>
        ))}
      </Section>
      <LfsSection repoPath={repoPath} />
      <WorktreeSection repoPath={repoPath} actions={actions} />
      <SubmoduleSection repoPath={repoPath} actions={actions} />
      <ReflogSection repoPath={repoPath} currentBranch={currentBranch} actions={actions} />
    </aside>
  )
}

function WorktreeSection({ repoPath, actions }: { repoPath: string; actions: Actions }) {
  const worktrees = useWorktrees(repoPath)
  const openMenu = useUiStore((s) => s.openMenu)
  const list = (worktrees.data ?? []).filter((w) => !w.bare)
  return (
    <Section
      title="Worktrees"
      count={list.length}
      testId="worktrees"
      action={{ label: '+', title: 'Add worktree', onClick: () => void actions.addWorktree() }}
    >
      {list.map((w) => (
        <li key={w.path}>
          <button
            data-testid="worktree-item"
            title={w.path}
            onDoubleClick={() => !w.isCurrent && void actions.openRepositoryAt(w.path)}
            onContextMenu={(e) => {
              e.preventDefault()
              openMenu(e.clientX, e.clientY, [
                { label: 'Open', disabled: w.isCurrent, onSelect: () => void actions.openRepositoryAt(w.path) },
                'separator',
                {
                  label: 'Remove worktree…',
                  danger: true,
                  disabled: w.isMain || w.isCurrent,
                  onSelect: () => void actions.removeWorktree(w.path),
                },
                {
                  label: 'Force remove (discard its changes)…',
                  danger: true,
                  disabled: w.isMain || w.isCurrent,
                  onSelect: () => void actions.removeWorktree(w.path, true),
                },
              ])
            }}
            className={`flex w-full items-center gap-2 truncate py-0.5 pr-3 pl-7 text-left hover:bg-panel-2 ${
              w.isCurrent ? 'font-semibold text-accent' : ''
            }`}
          >
            <span className="truncate">{w.branch ?? (w.head ? `detached ${shortSha(w.head)}` : w.path)}</span>
            <span className="ml-auto shrink-0 text-[10px] text-muted">
              {w.isMain ? 'main' : w.locked ? 'locked' : w.prunable ? 'missing' : ''}
            </span>
          </button>
        </li>
      ))}
    </Section>
  )
}

function SubmoduleSection({ repoPath, actions }: { repoPath: string; actions: Actions }) {
  const subs = useSubmodules(repoPath)
  const openMenu = useUiStore((s) => s.openMenu)
  if (!subs.data || subs.data.length === 0) return null
  const statusCls: Record<string, string> = {
    clean: 'text-ok',
    modified: 'text-warn',
    uninitialized: 'text-muted',
    conflict: 'text-err',
  }
  return (
    <Section
      title="Submodules"
      count={subs.data.length}
      testId="submodules"
      action={{ label: '⟳', title: 'Update all submodules', onClick: () => void actions.updateSubmodules() }}
    >
      {subs.data.map((m) => (
        <li key={m.path}>
          <button
            data-testid="submodule-item"
            title={m.url ?? m.path}
            onDoubleClick={() => m.status !== 'uninitialized' && void actions.openRepositoryAt(`${repoPath}/${m.path}`)}
            onContextMenu={(e) => {
              e.preventDefault()
              openMenu(e.clientX, e.clientY, [
                {
                  label: 'Open submodule',
                  disabled: m.status === 'uninitialized',
                  onSelect: () => void actions.openRepositoryAt(`${repoPath}/${m.path}`),
                },
                { label: m.status === 'uninitialized' ? 'Initialize and update' : 'Update', onSelect: () => void actions.updateSubmodules([m.path]) },
              ])
            }}
            className="flex w-full items-center gap-2 truncate py-0.5 pr-3 pl-7 text-left hover:bg-panel-2"
          >
            <span className="truncate">{m.path}</span>
            <span className={`ml-auto shrink-0 text-[10px] ${statusCls[m.status] ?? 'text-muted'}`}>{m.status}</span>
          </button>
        </li>
      ))}
    </Section>
  )
}

/** Where HEAD has been: the safety net for finding "lost" commits after resets or rebases. */
function ReflogSection({
  repoPath,
  currentBranch,
  actions,
}: {
  repoPath: string
  currentBranch: string | null
  actions: Actions
}) {
  const [open, setOpen] = useState(false)
  const reflog = useReflog(repoPath, open)
  const reveal = useAppStore((s) => s.reveal)
  const openMenu = useUiStore((s) => s.openMenu)
  const target = currentBranch ?? 'HEAD'

  return (
    <Section
      title="Reflog"
      count={reflog.data?.length ?? null}
      testId="reflog"
      open={open}
      onToggle={() => setOpen(!open)}
    >
      {reflog.isPending && open && <li className="px-7 py-0.5 text-xs text-muted">Loading…</li>}
      {reflog.data?.length === 0 && <li className="px-7 py-0.5 text-xs text-muted">No entries</li>}
      {reflog.data?.map((e) => (
        <li key={e.selector}>
          <button
            data-testid="reflog-item"
            data-sha={e.sha}
            title={`${e.selector} · ${e.message}`}
            onClick={() => reveal(e.sha)}
            onContextMenu={(ev) => {
              ev.preventDefault()
              openMenu(ev.clientX, ev.clientY, [
                { label: 'Create branch here…', onSelect: () => void actions.createBranch(e.sha) },
                { label: 'Checkout this commit (detached)', onSelect: () => void actions.checkoutCommit(e.sha) },
                'separator',
                { label: `Reset ${target} to here (mixed)`, onSelect: () => void actions.reset(e.sha, 'mixed') },
                { label: `Reset ${target} to here (hard)…`, danger: true, onSelect: () => void actions.reset(e.sha, 'hard') },
              ])
            }}
            className="flex w-full flex-col items-start py-0.5 pr-3 pl-7 text-left hover:bg-panel-2"
          >
            <span className="flex w-full items-center gap-1.5 text-xs">
              <span className="font-mono text-muted">{shortSha(e.sha)}</span>
              <span className="rounded bg-panel-2 px-1 text-[10px] text-muted">{e.action}</span>
              <span className="ml-auto text-[10px] text-muted">{formatShortDate(e.time)}</span>
            </span>
            <span className="w-full truncate text-xs">{e.message}</span>
          </button>
        </li>
      ))}
    </Section>
  )
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      {off && <path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  )
}

function Section({
  title,
  count,
  testId,
  action,
  children,
  open: controlledOpen,
  onToggle,
}: {
  title: string
  /** null hides the count (e.g. not loaded yet). */
  count: number | null
  testId: string
  action?: { label: string; title: string; onClick: () => void }
  children: React.ReactNode
  open?: boolean
  onToggle?: () => void
}) {
  const [localOpen, setLocalOpen] = useSectionOpen(testId)
  const open = controlledOpen ?? localOpen
  const setOpen = (v: boolean): void => (onToggle ? onToggle() : setLocalOpen(v))
  return (
    // Collapsed sections dock at the bottom of the sidebar (after the spacer), like GitKraken.
    <section className="mb-1" data-testid={testId} style={{ order: open ? 0 : 2 }}>
      <div className="flex items-center pr-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-1 px-3 py-1 text-xs font-semibold tracking-wider text-muted uppercase hover:text-fg"
          aria-expanded={open}
        >
          <span className="inline-block w-3">{open ? '▾' : '▸'}</span>
          {title}
          {count !== null && <span className="ml-auto font-normal">{count}</span>}
        </button>
        {action && (
          <button
            title={action.title}
            aria-label={action.title}
            onClick={action.onClick}
            className="ml-1 rounded px-1.5 text-muted hover:bg-panel-2 hover:text-fg"
          >
            {action.label}
          </button>
        )}
      </div>
      {open && <ul>{children}</ul>}
    </section>
  )
}

function RefItem({
  gitRef,
  active,
  onClick,
  onDoubleClick,
  onMenu,
  label,
  depth = 0,
  hidden = false,
  onToggleHidden,
}: {
  gitRef: GitRef
  label?: string
  depth?: number
  active: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onMenu?: (e: React.MouseEvent) => void
  /** Hidden from the graph (shown dimmed, with a crossed-out eye). */
  hidden?: boolean
  onToggleHidden?: () => void
}) {
  const drop = useDropTarget(gitRef)
  return (
    <li className="group relative">
      {onToggleHidden && (
        <button
          aria-label={hidden ? `Show ${gitRef.shortName} in the graph` : `Hide ${gitRef.shortName} from the graph`}
          title={hidden ? 'Show in the graph' : 'Hide from the graph'}
          data-testid="hide-ref"
          onClick={onToggleHidden}
          className={`absolute top-0.5 left-2 z-10 rounded p-0.5 text-muted hover:text-fg ${hidden ? '' : 'hidden group-hover:block'}`}
        >
          <EyeIcon off={hidden} />
        </button>
      )}
      <button
        draggable
        onDragStart={(e) => startDrag(e, { kind: 'ref', ref: gitRef })}
        onDragEnd={endDrag}
        {...drop.props}
        data-drop-over={drop.isOver || undefined}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          if (!onMenu) return
          e.preventDefault()
          onMenu(e)
        }}
        title={gitRef.name}
        data-testid="ref-item"
        data-ref={gitRef.name}
        data-hidden={hidden || undefined}
        style={{ paddingLeft: 28 + depth * 12 }}
        className={`flex w-full items-center gap-2 truncate py-0.5 pr-3 text-left hover:bg-panel-2 ${
          active ? 'font-semibold text-accent' : ''
        } ${hidden ? 'opacity-45' : ''} ${drop.isOver ? 'bg-accent/20 outline outline-1 -outline-offset-1 outline-accent' : ''}`}
      >
        {active && <span aria-label="current branch">●</span>}
        <span className="truncate">{label ?? gitRef.shortName}</span>
        {gitRef.upstream && (gitRef.ahead || gitRef.behind || gitRef.upstreamGone) ? (
          <span className="ml-auto shrink-0 text-[11px] font-normal text-muted" data-testid="ahead-behind">
            {gitRef.upstreamGone ? 'gone' : `${gitRef.ahead ? `↑${gitRef.ahead}` : ''}${gitRef.behind ? ` ↓${gitRef.behind}` : ''}`}
          </span>
        ) : null}
      </button>
    </li>
  )
}

function RemoteGroup({
  name,
  refs,
  onMenu,
  renderRef,
}: {
  name: string
  refs: GitRef[]
  onMenu: (e: React.MouseEvent) => void
  renderRef: (r: GitRef, label: string, depth: number) => React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <li>
        <button
          data-testid="remote-name"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          onContextMenu={(e) => {
            e.preventDefault()
            onMenu(e)
          }}
          className="flex w-full items-center gap-1.5 py-0.5 pr-3 pl-3 text-left text-muted hover:bg-panel-2 hover:text-fg"
        >
          <span className="inline-block w-3 text-[10px]">{open ? '▾' : '▸'}</span>
          <span aria-hidden>☁</span>
          <span className="truncate">{name}</span>
          <span className="ml-auto text-[10px]">{refs.length}</span>
        </button>
      </li>
      {open && (
        <RefTree
          refs={refs}
          scope={`remote:${name}`}
          nameOf={(r) => r.shortName.slice(name.length + 1)}
          depth={1}
          renderRef={renderRef}
        />
      )}
    </>
  )
}

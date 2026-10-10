import { useState } from 'react'
import { useReflog } from '../lib/queries'
import { formatShortDate, shortSha } from '../lib/format'
import type { GitRef, StashEntry } from '@shared/types'
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
}: {
  refs: GitRef[]
  currentRef: string | null
  remotes: string[]
  stashes: StashEntry[]
  actions: Actions
  repoPath: string
  currentBranch: string | null
}) {
  const selectStash = useAppStore((s) => s.selectStash)
  const selectedStash = useAppStore((s) => s.selectedStash)
  const reveal = useAppStore((s) => s.reveal)
  const openMenu = useUiStore((s) => s.openMenu)
  const local = refs.filter((r) => r.kind === 'head')
  const remote = refs.filter((r) => r.kind === 'remote')
  const tags = refs.filter((r) => r.kind === 'tag')
  const remoteBranchNames = remote.map((r) => r.shortName)

  const localMenu = (r: GitRef): MenuEntry[] => [
    { label: `Checkout ${r.shortName}`, disabled: r.name === currentRef, onSelect: () => void actions.checkout(r.name) },
    { label: 'Create branch here…', onSelect: () => void actions.createBranch(r.target) },
    'separator',
    { label: 'Rename…', onSelect: () => void actions.rename(r.shortName) },
    r.upstream
      ? { label: 'Unset upstream', onSelect: () => void actions.unsetUpstream(r.shortName) }
      : { label: 'Set upstream…', onSelect: () => void actions.setUpstream(r.shortName, remoteBranchNames) },
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
  ]

  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-r border-border bg-panel py-2" data-testid="sidebar">
      <Section title="Local" count={local.length} testId="local-branches">
        {local.map((r) => (
          <RefItem
            key={r.name}
            gitRef={r}
            active={r.name === currentRef}
            onClick={() => reveal(r.target)}
            onDoubleClick={() => r.name !== currentRef && void actions.checkout(r.name)}
            onMenu={(e) => openMenu(e.clientX, e.clientY, localMenu(r))}
          />
        ))}
      </Section>
      <Section
        title="Remote"
        count={remote.length}
        testId="remote-branches"
        action={{ label: '+', title: 'Add remote', onClick: () => void actions.addRemote() }}
      >
        {remotes.map((name) => (
          <li key={`remote:${name}`}>
            <div
              className="flex items-center gap-1 py-0.5 pr-3 pl-5 text-xs text-muted"
              data-testid="remote-name"
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(e.clientX, e.clientY, [
                  { label: 'Fetch', onSelect: () => void actions.fetch() },
                  { label: `Remove remote ${name}…`, danger: true, onSelect: () => void actions.removeRemote(name) },
                ])
              }}
            >
              ☁ {name}
            </div>
          </li>
        ))}
        {remote.map((r) => (
          <RefItem
            key={r.name}
            gitRef={r}
            active={false}
            onClick={() => reveal(r.target)}
            onDoubleClick={() => void actions.checkout(r.name)}
            onMenu={(e) => openMenu(e.clientX, e.clientY, remoteMenu(r))}
          />
        ))}
      </Section>
      <Section title="Tags" count={tags.length} testId="tags">
        {tags.map((r) => (
          <RefItem
            key={r.name}
            gitRef={r}
            active={false}
            onClick={() => reveal(r.target)}
            onMenu={(e) =>
              openMenu(e.clientX, e.clientY, [
                { label: `Push tag ${r.shortName}…`, onSelect: () => void actions.pushTag(r.shortName, remotes) },
                'separator',
                { label: `Delete tag ${r.shortName}…`, danger: true, onSelect: () => void actions.deleteTag(r.shortName) },
              ])
            }
          />
        ))}
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
      <ReflogSection repoPath={repoPath} currentBranch={currentBranch} actions={actions} />
    </aside>
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
      count={reflog.data?.length ?? 0}
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
  count: number
  testId: string
  action?: { label: string; title: string; onClick: () => void }
  children: React.ReactNode
  open?: boolean
  onToggle?: () => void
}) {
  const [localOpen, setLocalOpen] = useState(true)
  const open = controlledOpen ?? localOpen
  const setOpen = (v: boolean): void => (onToggle ? onToggle() : setLocalOpen(v))
  return (
    <section className="mb-1" data-testid={testId}>
      <div className="flex items-center pr-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-1 px-3 py-1 text-xs font-semibold tracking-wider text-muted uppercase hover:text-fg"
          aria-expanded={open}
        >
          <span className="inline-block w-3">{open ? '▾' : '▸'}</span>
          {title}
          <span className="ml-auto font-normal">{count}</span>
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
}: {
  gitRef: GitRef
  active: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <li>
      <button
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
        className={`flex w-full items-center gap-2 truncate py-0.5 pr-3 pl-7 text-left hover:bg-panel-2 ${
          active ? 'font-semibold text-accent' : ''
        }`}
      >
        {active && <span aria-label="current branch">●</span>}
        <span className="truncate">{gitRef.shortName}</span>
        {gitRef.upstream && (gitRef.ahead || gitRef.behind || gitRef.upstreamGone) ? (
          <span className="ml-auto shrink-0 text-[11px] font-normal text-muted" data-testid="ahead-behind">
            {gitRef.upstreamGone ? 'gone' : `${gitRef.ahead ? `↑${gitRef.ahead}` : ''}${gitRef.behind ? ` ↓${gitRef.behind}` : ''}`}
          </span>
        ) : null}
      </button>
    </li>
  )
}

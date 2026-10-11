import type { CommitSummary, GitRef, HistoryFilter, ProviderStatus, RemoteInfo } from '@shared/types'
import type { MenuEntry } from '../state/ui'
import type { useRepoActions } from './actions'
import { branchUrl, commitUrl } from './web-links'

export interface MenuContext {
  actions: ReturnType<typeof useRepoActions>
  bare: boolean
  headSha: string | null
  /** Full ref of the checked-out branch, null when detached. */
  currentRef: string | null
  refs: GitRef[]
  remotes: RemoteInfo[]
  provider: ProviderStatus | null
  hidden: string[]
  /** Whether `sha` is HEAD or one of its ancestors (on the current branch). */
  onCurrentBranch: (sha: string) => boolean
  openRebase: (base: string) => void
  openCompare: (sha: string) => void
  setHistoryFilter: (f: HistoryFilter | null) => void
  toggleHidden: (ref: string) => void
  onCreatePullRequest: (branch: GitRef) => void
}

const sep = 'separator' as const
const shortName = (ref: string | null): string => (ref ?? '').replace(/^refs\/heads\//, '')

function remoteOf(ref: GitRef, ctx: MenuContext): { remote: RemoteInfo | undefined; branch: string } | null {
  const full = ref.kind === 'remote' ? ref.name : ref.upstream
  const m = full ? /^refs\/remotes\/([^/]+)\/(.+)$/.exec(full) : null
  return m ? { remote: ctx.remotes.find((r) => r.name === m[1]), branch: m[2]! } : null
}

/** The remote to link commits to: the current branch's upstream remote, else origin, else any hosted one. */
function linkRemote(ctx: MenuContext): RemoteInfo | undefined {
  const cur = ctx.refs.find((r) => r.name === ctx.currentRef)
  const upstreamRemote = cur?.upstream ? /^refs\/remotes\/([^/]+)\//.exec(cur.upstream)?.[1] : undefined
  return ctx.remotes.find((r) => r.name === upstreamRemote && r.hosted) ?? ctx.remotes.find((r) => r.name === 'origin' && r.hosted) ?? ctx.remotes.find((r) => r.hosted)
}

/** Items shared by commit rows and branch labels for the commit `sha`. */
function commitItems(ctx: MenuContext, commit: CommitSummary, { checkout = true, worktree = true } = {}): MenuEntry[] {
  const a = ctx.actions
  const cur = shortName(ctx.currentRef) || 'HEAD'
  const isHead = commit.sha === ctx.headSha
  const onBranch = !!ctx.currentRef && ctx.onCurrentBranch(commit.sha)
  const isMerge = commit.parents.length > 1
  const items: MenuEntry[] = []
  if (checkout) items.push({ label: 'Checkout this commit', disabled: ctx.bare || isHead, onSelect: () => void a.checkoutCommit(commit.sha) }, sep)
  if (worktree) items.push({ label: 'Create worktree from this commit…', disabled: ctx.bare, onSelect: () => void a.addWorktree(commit.sha) }, sep)
  items.push(
    { label: 'Create branch here…', onSelect: () => void a.createBranch(commit.sha) },
    { label: 'Cherry pick commit', disabled: ctx.bare || onBranch, onSelect: () => void a.cherryPick(commit.sha) },
    { label: `Rebase ${cur} onto this commit…`, disabled: ctx.bare || !ctx.currentRef || isHead || onBranch, onSelect: () => void a.rebaseOntoCommit(commit.sha) },
  )
  if (ctx.headSha && !ctx.bare) {
    items.push(
      { label: `Reset ${cur} to this commit (soft: keep changes staged)`, onSelect: () => void a.reset(commit.sha, 'soft') },
      { label: `Reset ${cur} to this commit (mixed: keep changes unstaged)`, onSelect: () => void a.reset(commit.sha, 'mixed') },
      { label: `Reset ${cur} to this commit (hard: discard changes)…`, danger: true, onSelect: () => void a.reset(commit.sha, 'hard') },
    )
  }
  items.push({ label: 'Revert commit', disabled: ctx.bare, onSelect: () => void a.revert(commit.sha) })
  if (onBranch && !ctx.bare) {
    items.push(
      sep,
      { label: `Interactive rebase commits after ${commit.sha.slice(0, 7)}…`, disabled: isHead, onSelect: () => ctx.openRebase(commit.sha) },
      { label: 'Edit commit message…', disabled: isMerge, onSelect: () => void a.rewordCommit(commit, ctx.headSha) },
      { label: 'Drop commit…', disabled: isMerge || commit.parents.length === 0, onSelect: () => void a.dropCommit(commit) },
      { label: 'Move commit up', disabled: isMerge || isHead || commit.parents.length === 0, onSelect: () => void a.moveCommit(commit, 'up') },
      { label: 'Move commit down', disabled: isMerge || commit.parents.length === 0, onSelect: () => void a.moveCommit(commit, 'down') },
    )
  }
  return items
}

function trailingItems(ctx: MenuContext, commit: CommitSummary, ref?: GitRef): MenuEntry[] {
  const a = ctx.actions
  const items: MenuEntry[] = [sep]
  if (ref) items.push({ label: 'Copy branch name', onSelect: () => void a.copy(ref.kind === 'remote' ? ref.shortName.replace(/^[^/]+\//, '') : ref.shortName, 'the branch name') })
  items.push({ label: 'Copy commit SHA', onSelect: () => void a.copy(commit.sha, 'the commit SHA') })
  if (ref) {
    const r = remoteOf(ref, ctx)
    const url = r ? branchUrl(r.remote, r.branch) : null
    if (url) items.push({ label: `Copy link to branch: ${r!.remote!.name}/${r!.branch}`, onSelect: () => void a.copy(url, 'the branch link') })
  }
  const lr = linkRemote(ctx)
  const cUrl = commitUrl(lr, commit.sha)
  if (cUrl) items.push({ label: `Copy link to this commit on remote: ${lr!.name}`, onSelect: () => void a.copy(cUrl, 'the commit link') })
  if (!ref) items.push({ label: 'Create patch from commit…', onSelect: () => void a.savePatch(commit.sha) })
  if (ref && (ref.kind === 'head' || ref.kind === 'remote')) {
    const hidden = ctx.hidden.includes(ref.name)
    items.push(
      sep,
      { label: hidden ? 'Show' : 'Hide', disabled: ref.name === ctx.currentRef, onSelect: () => ctx.toggleHidden(ref.name) },
      { label: 'Solo', onSelect: () => ctx.setHistoryFilter({ refs: [ref.name] }) },
    )
  }
  items.push(
    sep,
    { label: 'Compare commit against working directory', disabled: ctx.bare, onSelect: () => ctx.openCompare(commit.sha) },
    sep,
    { label: 'Create tag here…', onSelect: () => void a.createTag(commit.sha) },
    { label: 'Create annotated tag here…', onSelect: () => void a.createTag(commit.sha, true) },
  )
  return items
}

/** Right-click on a commit row. */
export function commitMenu(ctx: MenuContext, commit: CommitSummary): MenuEntry[] {
  return [...commitItems(ctx, commit), ...trailingItems(ctx, commit)]
}

/** Right-click on a local branch (sidebar or graph label). */
export function localBranchMenu(ctx: MenuContext, ref: GitRef, commit: CommitSummary): MenuEntry[] {
  const a = ctx.actions
  const isCurrent = ref.name === ctx.currentRef
  const cur = ctx.refs.find((r) => r.name === ctx.currentRef)
  const curName = shortName(ctx.currentRef)
  const remoteNames = ctx.remotes.map((r) => r.name)
  const items: MenuEntry[] = []
  if (ref.upstream) {
    items.push({ label: 'Pull (fast-forward if possible)', onSelect: () => void (isCurrent ? a.pull('ff-only') : a.pullBranch(ref.shortName)) })
  }
  items.push({ label: 'Push', disabled: ctx.bare, onSelect: () => void a.push(ref, remoteNames) })
  items.push(
    ref.upstream
      ? { label: 'Unset upstream', onSelect: () => void a.unsetUpstream(ref.shortName) }
      : { label: 'Set upstream…', onSelect: () => void a.setUpstream(ref.shortName, ctx.refs.filter((r) => r.kind === 'remote').map((r) => r.shortName)) },
  )
  if (!isCurrent && cur && !ctx.bare) {
    const canFastForward = ctx.onCurrentBranch(ref.target) && ref.target !== ctx.headSha
    items.push(
      sep,
      ...(canFastForward ? [{ label: `Fast-forward ${ref.shortName} to ${curName}`, onSelect: () => void a.fastForward(ref.shortName, cur.name, curName) }] : []),
      { label: `Merge ${curName} into ${ref.shortName}`, onSelect: () => void a.mergeInto(ref, cur) },
      { label: `Merge ${ref.shortName} into ${curName}`, onSelect: () => void a.merge(ref) },
      { label: `Rebase ${curName} onto ${ref.shortName}…`, onSelect: () => void a.rebase(ref) },
    )
  }
  items.push(
    sep,
    { label: `Checkout ${ref.shortName}`, disabled: isCurrent || ctx.bare, onSelect: () => void a.checkout(ref.name) },
    sep,
    { label: `Create worktree from ${ref.shortName}…`, disabled: isCurrent || ctx.bare, onSelect: () => void a.addWorktreeForBranch(ref.shortName) },
    sep,
    ...commitItems(ctx, commit, { checkout: false, worktree: false }),
  )
  const pushed = ctx.provider?.connected && ref.upstream?.startsWith(`refs/remotes/${ctx.provider.remote}/`)
  if (pushed) items.push(sep, { label: 'Create pull request…', onSelect: () => ctx.onCreatePullRequest(ref) })
  if (ref.upstream) {
    const remote = ref.upstream.replace(/^refs\/remotes\/([^/]+)\/.*$/, '$1')
    items.push({ label: 'Force push (with lease)…', danger: true, onSelect: () => void a.forcePush(ref, remote) })
  }
  items.push(
    sep,
    { label: `Rename ${ref.shortName}…`, onSelect: () => void a.rename(ref.shortName) },
    { label: `Delete ${ref.shortName}…`, danger: true, disabled: isCurrent, onSelect: () => void a.deleteBranch(ref.shortName) },
    ...trailingItems(ctx, commit, ref),
  )
  return items
}

/** Right-click on a remote branch (sidebar or graph label). */
export function remoteBranchMenu(ctx: MenuContext, ref: GitRef, commit: CommitSummary): MenuEntry[] {
  const a = ctx.actions
  const cur = shortName(ctx.currentRef)
  const items: MenuEntry[] = []
  if (ctx.currentRef && !ctx.bare) {
    items.push(
      { label: `Rebase ${cur} onto ${ref.shortName}…`, onSelect: () => void a.rebase(ref) },
      {
        label: `Interactive rebase ${cur} onto ${ref.shortName}…`,
        disabled: !ctx.onCurrentBranch(ref.target) || ref.target === ctx.headSha,
        onSelect: () => ctx.openRebase(ref.target),
      },
      { label: `Merge ${ref.shortName} into ${cur}`, onSelect: () => void a.merge(ref) },
      sep,
    )
  }
  items.push(
    { label: `Checkout ${ref.shortName}`, disabled: ctx.bare, onSelect: () => void a.checkout(ref.name) },
    sep,
    { label: `Create worktree from ${ref.shortName}…`, disabled: ctx.bare, onSelect: () => void a.addWorktree(ref.target) },
    sep,
    ...commitItems(ctx, commit, { checkout: false, worktree: false }),
    sep,
    { label: `Delete ${ref.shortName}…`, danger: true, onSelect: () => void a.deleteRemoteBranch(ref) },
    ...trailingItems(ctx, commit, ref),
  )
  return items
}

/** Collapse runs of separators and trim them at the ends. */
export function tidy(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const i of items) {
    if (i === 'separator' && (out.length === 0 || out[out.length - 1] === 'separator')) continue
    out.push(i)
  }
  while (out[out.length - 1] === 'separator') out.pop()
  return out
}

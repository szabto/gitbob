import type {
  CheckStatus,
  ProviderStatus,
  PullRequest,
  BlameLine,
  RebaseCommit,
  SignatureInfo,
  SubmoduleInfo,
  WorktreeInfo,
  ConflictVersions,
  FileContents,
  FileChange,
  ReflogEntry,
  ResetResult,
  StashEntry,
  TagInfo,
  RemoteInfo,
  CommitResult,
  FileDiff,
  WorkingTreeStatus,
  CommitDetails,
  CommitPage,
  GitRef,
  HeadState,
  RecentRepository,
  RepositoryInfo,
} from './types'
import type { IpcChannel, IpcEventName } from './channels'

/** Static response types per channel (data payload of the Result envelope). */
export interface IpcOutputs {
  'repo:open': RepositoryInfo
  'repo:pick': RepositoryInfo | null
  'repo:recent': RecentRepository[]
  'repo:activate': void
  /** null if the user cancelled the folder picker. */
  'repo:clone': RepositoryInfo | null
  'repo:init': RepositoryInfo | null
  'repo:refs': GitRef[]
  'repo:head': HeadState
  'log:page': CommitPage
  'log:search': { shas: string[]; truncated: boolean }
  'commit:details': CommitDetails
  'status:get': WorkingTreeStatus
  'index:stage': void
  'index:unstage': void
  'index:stage-all': void
  'index:unstage-all': void
  /** False if the user declined the confirmation dialog. */
  'worktree:discard': { discarded: boolean }
  'diff:file': FileDiff
  'diff:contents': FileContents
  /** `applied: false` if the user declined the discard confirmation. */
  'diff:apply-hunks': { applied: boolean }
  'conflict:get': ConflictVersions
  'conflict:save': void
  'commit:create': CommitResult
  /** Full message of HEAD, or null on an unborn branch (used to prefill amend). */
  'commit:last-message': string | null
  'branch:create': void
  'branch:checkout': { branch: string }
  'commit:checkout': void
  'branch:rename': void
  /** False if the user declined the confirmation dialog. */
  'branch:delete': { deleted: boolean }
  'branch:set-upstream': void
  'remote:list': RemoteInfo[]
  'remote:add': void
  'remote:remove': { removed: boolean }
  'remote:fetch': void
  'remote:pull': void
  /** False if the user declined the force-push confirmation. */
  'remote:push': { pushed: boolean }
  'stash:list': StashEntry[]
  'stash:create': { created: boolean }
  'stash:apply': void
  'stash:drop': { dropped: boolean }
  'stash:files': FileChange[]
  'tag:list': TagInfo[]
  'tag:create': void
  'tag:delete': { deleted: boolean }
  'tag:push': void
  /** `done: false` if the user declined the confirmation. */
  'history:reset': ResetResult & { done: boolean }
  'history:revert': void
  'history:cherry-pick': void
  'op:continue': { operation: string }
  /** `operation: null` if the user declined the confirmation. */
  'op:abort': { operation: string | null }
  'op:skip': { operation: string }
  'reflog:get': ReflogEntry[]
  'rebase:todo': RebaseCommit[]
  /** completed: false when the rebase stopped on a conflict (banner takes over). */
  'rebase:start': { completed: boolean }
  'blame:get': { lines: BlameLine[]; text: string[] }
  'worktree:list': WorktreeInfo[]
  /** null if the user cancelled the folder picker. */
  'worktree:add': { path: string } | null
  'worktree:remove': { removed: boolean }
  'submodule:list': SubmoduleInfo[]
  'submodule:update': void
  'commit:signature': SignatureInfo
  'settings:get': { theme: 'system' | 'light' | 'dark' }
  'provider:status': ProviderStatus
  'provider:connect': { user: string }
  'provider:disconnect': { disconnected: boolean }
  'provider:pulls': PullRequest[]
  /** null when the repository has no connected provider. */
  'provider:checks': CheckStatus | null
  'provider:create-pr': PullRequest
  'credentials:respond': void
  /** True if a running network operation was cancelled. */
  'op:cancel': boolean
}

// Compile-time check that IpcOutputs covers exactly the declared channels.
type _Exhaustive = [IpcChannel] extends [keyof IpcOutputs]
  ? [keyof IpcOutputs] extends [IpcChannel]
    ? true
    : never
  : never
export const _ipcOutputsExhaustive: _Exhaustive = true

/** Main -> renderer push events. */
export interface IpcEvents {
  /** Request from the native menu to show the open-repository dialog. */
  'menu:open-repository': void
  /** A repository was opened from outside the renderer (CLI arg, menu). */
  'repo:opened': RepositoryInfo
  /** The working tree, index or refs of an opened repository changed on disk (debounced). */
  'repo:changed': { repoPath: string }
  /** Git needs a username/password/token; answer with credentials:respond. */
  'credentials:request': {
    id: string
    prompt: string
    secret: boolean
    /** ssh host-key question: answer "yes" to trust, or cancel. */
    confirm: boolean
    /** git https username/password prompt that may be saved to the OS keychain. */
    rememberable: boolean
  }
  /** Remembered credentials were (or could not be) handed to a secure credential helper. */
  'credentials:saved': { host: string; saved: boolean }
  /** A pending credentials request is no longer needed (operation finished or cancelled). */
  'credentials:cancel': { id: string }
  /** Progress of the running network operation. */
  'op:progress': { phase: string; percent: number }
  /** The user picked a theme in View → Theme. */
  'theme:changed': { theme: 'system' | 'light' | 'dark' }
  'menu:clone-repository': void
  'menu:init-repository': void
}

type _EventsExhaustive = [IpcEventName] extends [keyof IpcEvents]
  ? [keyof IpcEvents] extends [IpcEventName]
    ? true
    : never
  : never
export const _ipcEventsExhaustive: _EventsExhaustive = true

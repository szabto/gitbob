import type {
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
  'credentials:request': { id: string; prompt: string; secret: boolean }
  /** A pending credentials request is no longer needed (operation finished or cancelled). */
  'credentials:cancel': { id: string }
  /** Progress of the running network operation. */
  'op:progress': { phase: string; percent: number }
}

type _EventsExhaustive = [IpcEventName] extends [keyof IpcEvents]
  ? [keyof IpcEvents] extends [IpcEventName]
    ? true
    : never
  : never
export const _ipcEventsExhaustive: _EventsExhaustive = true

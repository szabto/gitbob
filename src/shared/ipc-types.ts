import type {
  AppInfo,
  ProfileInfo,
  FileHistoryPage,
  HostedRepository,
  ProviderAccount,
  PullRequestComment,
  PullRequestDetail,
  ConflictDescription,
  LfsStatus,
  AppSettings,
  UpdateInfo,
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
  /** Performance hints for a slow repository. */
  'repo:health': { suggestCommitGraph: boolean }
  'repo:write-commit-graph': void
  'file:history': FileHistoryPage
  /** A native confirmation dialog; true if confirmed. */
  'app:confirm': boolean
  'app:copy': void
  'commit:reword-head': void
  /** deleted: false if the user declined. */
  'branch:delete-remote': { deleted: boolean }
  'branch:fast-forward': { moved: boolean }
  /** Fetch the branch's upstream and fast-forward it (it isn't checked out). */
  'branch:pull-other': { moved: boolean }
  'compare:files': FileChange[]
  /** null if the save dialog was cancelled. */
  'commit:save-patch': { path: string } | null
  'profile:list': { active: string; profiles: ProfileInfo[] }
  'profile:create': ProfileInfo
  'profile:rename': void
  /** removed: false if the user declined. */
  'profile:remove': { removed: boolean }
  /** The app restarts into the profile. */
  'profile:switch': void
  'repo:open-terminal': void
  'repo:reveal': void
  'commit:all-files': { paths: string[]; truncated: boolean }
  /** Avatar image as a data URL, or null (none, or avatars are off). */
  'avatar:get': string | null
  /** commit.template contents without comment lines, or null. */
  'commit:template': string | null
  /** A working-tree text file for editing and a hash of the content read. */
  'file:read': { text: string; hash: string }
  /** Saved only if the file still had baseHash; returns the new hash. */
  'file:write': { hash: string }
  'branch:merge': { fastForward: boolean; upToDate: boolean }
  /** done: false if the user declined the confirmation. */
  'branch:rebase': { done: boolean }
  'repo:head': HeadState
  'log:page': CommitPage
  'log:count': number
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
  'conflict:describe': ConflictDescription
  /** resolved: false if the user declined the confirmation. */
  'conflict:resolve-with': { resolved: boolean }
  'lfs:status': LfsStatus
  'lfs:install': void
  'lfs:track': { changed: boolean }
  'lfs:untrack': { changed: boolean }
  'lfs:pull': { checkoutSkipped: boolean }
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
  'stash:branch': void
  'stash:apply-file': void
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
  'settings:get': AppSettings
  'settings:update': AppSettings
  'app:info': AppInfo
  'app:check-update': UpdateInfo
  'app:download-update': void
  'app:install-update': void
  /** The validated git path, or null if the user cancelled. */
  'app:pick-git': { path: string; version: string } | null
  'app:git-identity': { name: string; email: string }
  'app:set-git-identity': void
  'provider:status': ProviderStatus
  'provider:connect': { user: string }
  'provider:disconnect': { disconnected: boolean }
  'provider:pulls': PullRequest[]
  /** null: no issue tracker (Azure DevOps work items aren't supported; Bitbucket's may be off). */
  'provider:issues': import('./types').Issue[] | null
  /** null when the repository has no connected provider. */
  'provider:checks': CheckStatus | null
  'provider:create-pr': PullRequest
  'provider:accounts': ProviderAccount[]
  'provider:hosted-repos': HostedRepository[]
  'provider:pr': PullRequestDetail
  'provider:pr-comments': PullRequestComment[]
  'provider:pr-comment': PullRequestComment
  'provider:pr-line-comment': PullRequestComment
  'provider:pr-review': void
  /** done: false if the user declined the confirmation. */
  'provider:pr-merge': { done: boolean; merged: boolean; message: string }
  /** Merge base, head and changed files of the pull request (its commits are fetched locally). */
  'provider:pr-changes': { base: string; head: string; files: import('./types').FileChange[] }
  'provider:signin-start': { userCode: string; verificationUri: string }
  'provider:signin-finish': { user: string }
  'provider:signin-cancel': void
  /** Labels of the actions undo/redo would revert or repeat (null: nothing). */
  'undo:state': { undo: string | null; redo: string | null }
  'undo:undo': { label: string }
  'undo:redo': { label: string }
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
  'menu:settings': void
  'menu:command-palette': void
  'settings:changed': AppSettings
  'app:update-available': UpdateInfo
  'app:update-progress': { percent: number }
  'app:update-downloaded': { version: string }
}

type _EventsExhaustive = [IpcEventName] extends [keyof IpcEvents]
  ? [keyof IpcEvents] extends [IpcEventName]
    ? true
    : never
  : never
export const _ipcEventsExhaustive: _EventsExhaustive = true

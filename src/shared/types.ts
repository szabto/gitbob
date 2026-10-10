/** Domain types shared between main, preload and renderer. Plain data only (structured-clone safe). */

export interface CommitSummary {
  sha: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** Unix epoch seconds. */
  authorTime: number
  committerName: string
  committerEmail: string
  /** Unix epoch seconds. */
  commitTime: number
  subject: string
}

export type RefKind = 'head' | 'remote' | 'tag' | 'stash' | 'other'

export interface GitRef {
  /** Full ref name, e.g. refs/heads/main. */
  name: string
  /** Short display name, e.g. main or origin/main. */
  shortName: string
  kind: RefKind
  /** Commit the ref ultimately points to (annotated tags are peeled). */
  target: string
  /** Full name of the configured upstream, if any (local branches only). */
  upstream?: string
  /** Commits ahead of / behind the upstream (only when `upstream` is set). */
  ahead?: number
  behind?: number
  /** The configured upstream no longer exists on the remote. */
  upstreamGone?: true
}

export interface HeadState {
  /** Commit HEAD points to; null on an unborn branch. */
  sha: string | null
  /** Full ref name if HEAD is symbolic (attached), null if detached. */
  ref: string | null
  detached: boolean
  unborn: boolean
}

export interface RepositoryInfo {
  /** Absolute worktree root (or git dir for bare repositories). */
  root: string
  gitDir: string
  bare: boolean
  name: string
}

export interface CommitPage {
  commits: CommitSummary[]
  /** True if more commits are available after this page. */
  hasMore: boolean
}

export type FileChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X'

export interface FileChange {
  status: FileChangeStatus
  path: string
  /** Original path for renames/copies. */
  oldPath?: string
  /** Lines added; null for binary files. */
  additions: number | null
  /** Lines deleted; null for binary files. */
  deletions: number | null
}

export interface CommitDetails extends CommitSummary {
  body: string
  /** Files changed relative to the first parent (or the empty tree for root commits). */
  files: FileChange[]
}

export interface RecentRepository {
  path: string
  name: string
  /** Epoch milliseconds. */
  lastOpened: number
}

// ---------------------------------------------------------------------------
// Working tree (M2)

/**
 * Porcelain v2 status letter for one side (index or worktree):
 * '.' unmodified, M modified, T type change, A added, D deleted, R renamed,
 * C copied, U updated-but-unmerged, '?' untracked, '!' ignored.
 */
export type StatusCode = '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!'

export interface StatusEntry {
  path: string
  /** Original path for renames/copies in the index. */
  origPath?: string
  /** Index (staged) state. */
  index: StatusCode
  /** Worktree (unstaged) state. */
  worktree: StatusCode
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored'
  /** True for submodule entries. */
  submodule: boolean
}

export interface BranchStatus {
  /** Current commit, null when unborn. */
  oid: string | null
  /** Branch name, null when detached. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export interface WorkingTreeStatus {
  branch: BranchStatus
  entries: StatusEntry[]
  /** In-progress operation detected from the git dir, if any. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null
}

export type DiffLineType = 'context' | 'add' | 'del' | 'no-newline'

export interface DiffLine {
  type: DiffLineType
  content: string
  /** Line number in the old file (context/del). */
  oldLine: number | null
  /** Line number in the new file (context/add). */
  newLine: number | null
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath?: string
  binary: boolean
  /** True if git reported a new file / deleted file. */
  isNew: boolean
  isDeleted: boolean
  hunks: DiffHunk[]
  /** True if the diff was truncated because it exceeded the size limit. */
  truncated: boolean
}

/** Where a file diff is taken from. */
export type DiffTarget =
  | { kind: 'unstaged'; path: string }
  | { kind: 'staged'; path: string }
  | { kind: 'untracked'; path: string }
  | { kind: 'commit'; sha: string; path: string; oldPath?: string }

export interface CommitResult {
  sha: string
  summary: string
}

// ---------------------------------------------------------------------------
// Branches and remotes (M3)

export interface RemoteInfo {
  name: string
  fetchUrl: string
  pushUrl: string
}

// ---------------------------------------------------------------------------
// Stash, tags, history operations, reflog (M5)

export interface StashEntry {
  index: number
  /** `stash@{n}` */
  ref: string
  sha: string
  /**
   * The user's message for named stashes (`On <branch>: <message>`), otherwise git's
   * full default subject (`WIP on <branch>: <sha> <subject>`).
   */
  message: string
  /** Branch the stash was created on; null when created on a detached HEAD. */
  branch: string | null
  /** Creation time, epoch seconds. */
  time: number
}

export interface TagInfo {
  /** Short tag name (without `refs/tags/`). */
  name: string
  /** Fully peeled target object (a commit for ordinary tags). */
  target: string
  annotated: boolean
  /** Annotation message (subject + body, signature excluded); '' for lightweight tags. */
  message: string
  /** Tagger of annotated tags; null for lightweight tags. */
  taggerName: string | null
  /** Tagger date (epoch s) of annotated tags; null for lightweight tags. */
  time: number | null
}

export interface ResetResult {
  /**
   * Commit id of the safety stash created before a hard reset (also stored as `stash@{0}`),
   * or null when there was nothing to back up. Recover with `git stash apply <id>`; untracked
   * or ignored files that the reset overwrote are kept in the stash's third parent.
   */
  backupStash: string | null
}

export interface ReflogEntry {
  /** Commit the ref pointed to after this update. */
  sha: string
  /** Selector usable with git, e.g. `HEAD@{3}` or `refs/heads/main@{0}`. */
  selector: string
  /** Kind of update, e.g. "commit", "commit (amend)", "checkout", "reset", "rebase (finish)". */
  action: string
  /** Rest of the reflog message, e.g. "moving from main to topic". */
  message: string
  /** Time of the ref update, epoch seconds. */
  time: number
}

export type ResetMode = 'soft' | 'mixed' | 'hard'

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
  /** Stash files only: the commit holding this untracked file (the stash's third parent). */
  untrackedIn?: string
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
  | { kind: 'staged'; path: string; /** Original path of a staged rename. */ oldPath?: string }
  | { kind: 'untracked'; path: string }
  | { kind: 'commit'; sha: string; path: string; oldPath?: string }
  /** Changes between two commits (e.g. a pull request: merge base → head). */
  | { kind: 'range'; base: string; head: string; path: string; oldPath?: string }

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
  /** Hosting service and owner, when the URL points to a recognized one (for its project icon). */
  hosted?: { kind: ProviderKind; owner: string }
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

// ---------------------------------------------------------------------------
// Diff and merge (M6)

/** Full contents of both sides of a file diff (null = that side does not exist). */
export interface FileContents {
  oldText: string | null
  newText: string | null
  binary: boolean
  tooLarge: boolean
}

/** A hunk (optionally a subset of its lines) chosen for staging, unstaging or discarding. */
export interface HunkSelection {
  hunkIndex: number
  /** The hunk's "@@ ... @@" header as shown, used to reject stale requests. */
  header: string
  /** Indices into hunk.lines; omitted means the whole hunk. */
  lines?: number[]
}

/** The three versions of a conflicted file plus its current (marked-up) content. */
export interface ConflictVersions {
  base: string | null
  ours: string | null
  theirs: string | null
  merged: string
  binary: boolean
  oursLabel: string
  theirsLabel: string
}

// ---------------------------------------------------------------------------
// Rebase, blame, worktrees, submodules, signatures (M5 rest)

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface RebaseTodoItem {
  sha: string
  action: RebaseAction
  /** Required for reword; optional combined message for squash. */
  message?: string
}

export interface RebaseCommit {
  sha: string
  subject: string
  authorName: string
  time: number
}

export interface BlameLine {
  line: number
  sha: string
  authorName: string
  authorTime: number
  summary: string
  originalLine: number
  boundary: boolean
}

export interface WorktreeInfo {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
  isMain: boolean
  isCurrent: boolean
}

export interface SubmoduleInfo {
  path: string
  url: string | null
  sha: string | null
  status: 'uninitialized' | 'clean' | 'modified' | 'conflict'
  branch: string | null
}

export interface SignatureInfo {
  status: 'good' | 'bad' | 'unknown-validity' | 'expired' | 'expired-key' | 'revoked' | 'missing-key' | 'none' | 'error'
  signer: string | null
  key: string | null
}

/** Narrow the history graph. All fields optional; combined with AND. */
export interface HistoryFilter {
  /** Full ref names (refs/heads/x, refs/remotes/o/x, refs/tags/t): only commits reachable from these. */
  refs?: string[]
  /** Author name or email contains this text (case-insensitive, literal). */
  author?: string
  /** Only commits touching this repository-relative path. */
  path?: string
}

// ---------------------------------------------------------------------------
// Hosting providers (M7)

export type ProviderKind = 'github' | 'gitlab' | 'bitbucket' | 'azure'

export type PullRequestState = 'open' | 'closed' | 'merged'

export interface RepoRef {
  kind: ProviderKind
  /** Web host, e.g. `github.com`, `gitlab.example.com:8443`, `dev.azure.com`. */
  host: string
  /** GitHub owner, GitLab namespace path (may contain '/'), Bitbucket workspace, Azure organization. */
  owner: string
  /** Azure DevOps project. Undefined for other providers. */
  project?: string
  repo: string
  /** Browser URL of the repository (never contains credentials). */
  webUrl: string
}

/** One commit in a file's history (renames followed). */
export interface FileHistoryEntry {
  commit: CommitSummary
  /** How the commit changed the file: Added, Modified, Deleted, Renamed, Copied, Type change. */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X'
  /** The file's path in this commit. */
  path: string
  /** Previous path when this commit renamed or copied the file. */
  oldPath?: string
}

export interface FileHistoryPage {
  entries: FileHistoryEntry[]
  hasMore: boolean
}

/** An issue of a hosted repository. */
export interface Issue {
  number: number
  title: string
  author: string
  url: string
  labels: string[]
  comments: number
  updatedAt: string
}

/** A repository the signed-in user can access on a hosting service (for cloning). */
export interface HostedRepository {
  kind: ProviderKind
  /** Account host the token is stored for, e.g. `github.com`, `dev.azure.com`. */
  host: string
  /** `owner/name` (GitLab: full namespace path; Azure: `organization/project/name`). */
  fullName: string
  description: string | null
  private: boolean
  /** HTTPS clone URL without credentials. */
  cloneUrl: string
  sshUrl: string | null
  /** ISO timestamp of the last update/push, when known. */
  updatedAt: string | null
}

/** A hosting-service account with a saved token. */
export interface ProviderAccount {
  kind: ProviderKind
  host: string
}

export interface PullRequest {
  /** Provider-global id (GitHub/GitLab numeric id; Bitbucket/Azure: same as number). */
  id: number | string
  /** Per-repository number shown to users (GitHub number, GitLab iid, Bitbucket id, Azure pullRequestId). */
  number: number
  title: string
  author: string
  state: PullRequestState
  draft: boolean
  /** Branch name without `refs/heads/`. */
  sourceBranch: string
  /** Branch name without `refs/heads/`. */
  targetBranch: string
  /** Browser URL of the pull/merge request. */
  url: string
  createdAt: string
  updatedAt: string
}

export interface CheckStatus {
  state: 'success' | 'failure' | 'pending' | 'none'
  total: number
  failed: number
  pending: number
  /** Link to the most relevant check (first failing, else first pending, else first). */
  url?: string
}

/** Provider connection state for the open repository. */
export interface ProviderStatus {
  /** The hosting repository behind the first matching remote, or null if none is recognized. */
  repo: RepoRef | null
  remote: string | null
  connected: boolean
  /** Login of the connected account. */
  user: string | null
  /** Encrypted token storage is available on this system. */
  canStoreTokens: boolean
  /** "Sign in with GitHub" (device flow) is available. */
  canSignIn: boolean
}

// ---------------------------------------------------------------------------
// Settings and app info (M8)

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  usePlatformCredentialHelper: boolean
  gitPath: string | null
  /** Command id -> accelerator overrides, e.g. { "repo.fetch": "Mod+Shift+F" }. */
  shortcuts: Record<string, string>
  autoCheckUpdates: boolean
  /** GitHub OAuth app client id for "Sign in with GitHub"; null uses the built-in one (if any). */
  githubClientId: string | null
  /** Commit author avatars: initials only, from the hosting service (GitHub), or also Gravatar. */
  avatars: 'off' | 'hosting' | 'gravatar'
}

export interface AppInfo {
  version: string
  platform: string
  home: string
  gitPath: string
  gitVersion: string | null
}

export interface UpdateInfo {
  current: string
  latest: string | null
  newer: boolean
  url: string | null
  /** The update can be downloaded and installed from inside the app (Windows, Linux AppImage). */
  canInstall?: boolean
}

// ---------------------------------------------------------------------------
// Git LFS and non-text conflicts

export interface LfsTrackedPattern {
  /** The pattern as written in the attributes file (git-lfs escapes spaces as `[[:space:]]`). */
  pattern: string
  /** Repository-relative attributes file that defines it, e.g. `.gitattributes` or `assets/.gitattributes`. */
  source: string
}

export interface LfsFile {
  path: string
  /** Full sha256 object id. */
  oid: string
  /** True if the worktree has the real content (`*` in `git lfs ls-files`), false for a pointer (`-`). */
  downloaded: boolean
}

export interface LfsStatus {
  /** git-lfs is available to the git used by GitBob. */
  installed: boolean
  /** e.g. "git-lfs/3.7.1 (GitHub; darwin arm64; go 1.26.4)"; null when not installed. */
  version: string | null
  /** LFS filters are configured for this repository (any config scope: filter.lfs.process or .smudge). */
  enabledInRepo: boolean
  trackedPatterns: LfsTrackedPattern[]
  /** LFS files in the checked-out tree (at most LFS_FILES_LIMIT). */
  files: LfsFile[]
  /** True if there were more than LFS_FILES_LIMIT files and the list was cut. */
  filesTruncated: boolean
}

/**
 * How a conflict can be resolved:
 * - `content`: all three stages are text, so it can be merged line by line
 * - `binary`: both sides exist but at least one is binary (NUL byte, `-diff`/`binary` attributes or
 *   an LFS pointer) — pick a side
 * - `modify-delete`: one side deleted the file (`deletedBy` says which)
 * - `add-add`: both sides added the file (no base); text, so it can be merged
 * - `other`: submodules, symlinks, rename/rename and other stage combinations
 */
export type ConflictKind = 'content' | 'binary' | 'modify-delete' | 'add-add' | 'other'

export interface ConflictDescription {
  kind: ConflictKind
  /** Index stages present (1 = base, 2 = ours, 3 = theirs). */
  stages: number[]
  /** For modify/delete: the side that deleted the file. */
  deletedBy: 'ours' | 'theirs' | null
  /** True if any side is binary, whatever the kind. */
  binary: boolean
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export type MergeableState = 'yes' | 'no' | 'conflicts' | 'unknown'

export type ReviewerState = 'approved' | 'changes-requested' | 'commented' | 'pending'

export interface PullRequestReviewer {
  login: string
  state: ReviewerState
}

/** A pull request with the extra data needed to review and merge it. */
export interface PullRequestDetail extends PullRequest {
  /** Description as markdown; empty when there is none. */
  body: string
  /** Target commit the provider compares against (Bitbucket: abbreviated hash). */
  baseSha: string | null
  /** Current head commit of the source branch (Bitbucket: abbreviated hash). */
  headSha: string | null
  /**
   * 'yes' = the provider reports it can merge; 'no' = blocked (closed, draft, failing policy or
   * protection rule); 'conflicts' = merge conflicts; 'unknown' = the provider is still computing.
   */
  mergeable: MergeableState
  /** Merge methods the repository allows, when the provider says; otherwise every method supported. */
  mergeMethods: MergeMethod[]
  reviewers: PullRequestReviewer[]
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  /** The source branch lives in another repository (fork). */
  headRepoIsFork: boolean
}

export interface PullRequestComment {
  id: string
  author: string
  /** Markdown. */
  body: string
  createdAt: string
  /** File path for inline (diff) comments. */
  path?: string
  /** Line of an inline comment, in the new version (side 'new', default) or the old one. */
  line?: number
  side?: 'old' | 'new'
}

/** Where to place an inline review comment: a line of the pull request's diff. */
export interface LineCommentInput {
  path: string
  /** Old path of a renamed file (GitLab needs both). */
  oldPath?: string
  line: number
  /** 'new': an added or unchanged line (numbered in the new file); 'old': a removed line. */
  side: 'old' | 'new'
  body: string
  /** Head commit the comment refers to; must be the pull request's current head. */
  headSha: string
}

export type ReviewEvent = 'approve' | 'comment' | 'request-changes'

import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkingTreeStatus } from '@shared/types'
import { GitError } from './errors'
import { runGit, type RunResult } from './runner'
import { getOperation, runStatus } from './status'
import type { ResetResult } from '@shared/types'
export type { ResetResult }

export type ResetMode = 'soft' | 'mixed' | 'hard'
export type GitOperation = NonNullable<WorkingTreeStatus['operation']>


const SHA_RE = /^[0-9a-f]{4,64}$/i
/** Commits run hooks; give them time. */
const COMMIT_TIMEOUT = 5 * 60_000
const INDEX_TIMEOUT = 120_000
const ALL_EXIT_CODES = Array.from({ length: 256 }, (_, i) => i)
/** Never open an editor: messages are taken as-is (`--no-edit` semantics). */
const NO_EDITOR_ENV = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }

const LABEL: Record<GitOperation, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  bisect: 'Bisect',
}

function assertSha(sha: unknown): asserts sha is string {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new GitError('INVALID_ARGUMENT', 'Invalid commit id')
}

/** Resolve a validated hex id to a full commit id and its parents. */
async function resolveCommit(repoPath: string, sha: string): Promise<{ sha: string; parents: string[] }> {
  assertSha(sha)
  const r = await runGit(['rev-list', '--parents', '-n', '1', `${sha}^{commit}`, '--'], {
    cwd: repoPath,
    okExitCodes: [0, 128],
  })
  const [full = '', ...parents] = r.stdout.trim().split(' ')
  if (r.exitCode !== 0 || !full) throw new GitError('NOT_FOUND', `Commit ${sha} not found`)
  return { sha: full, parents }
}

function output(r: RunResult): string {
  return [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n')
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').replace(/^(fatal|error|hint): /, '')
}

async function conflictedPaths(repoPath: string): Promise<string[]> {
  const { entries } = await runStatus(repoPath)
  return entries.filter((e) => e.kind === 'unmerged').map((e) => e.path)
}

/** Build the error for a failed sequencer/merge command, distinguishing conflicts from other stops. */
async function stoppedError(repoPath: string, label: string, r: RunResult): Promise<GitError> {
  const detail = output(r)
  const [op, conflicts] = await Promise.all([getOperation(repoPath), conflictedPaths(repoPath)])
  if (conflicts.length) {
    return new GitError(
      'GIT_FAILED',
      `${label} stopped because of conflicts in ${conflicts.join(', ')}. Resolve them, stage the files and continue, or abort.`,
      { detail, exitCode: r.exitCode },
    )
  }
  if (op) {
    return new GitError(
      'GIT_FAILED',
      `${label} stopped: ${firstLine(detail) || 'git needs your attention'}. Continue, skip or abort the ${LABEL[op].toLowerCase()}.`,
      { detail, exitCode: r.exitCode },
    )
  }
  return new GitError('GIT_FAILED', firstLine(detail) || `${label} failed with exit code ${r.exitCode}`, {
    detail,
    exitCode: r.exitCode,
  })
}

async function assertNoOperation(repoPath: string): Promise<void> {
  const op = await getOperation(repoPath)
  if (op) throw new GitError('INVALID_ARGUMENT', `A ${LABEL[op].toLowerCase()} is already in progress; finish or abort it first`)
}

// ---------------------------------------------------------------------------
// Reset

async function pathKind(abs: string): Promise<'file' | 'dir' | null> {
  try {
    const s = await lstat(abs)
    return s.isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

/**
 * Untracked (or ignored) worktree files that `reset --hard <target>` would silently overwrite or
 * remove: paths tracked in `target` but not in the index that exist on disk, files sitting where
 * the target has a directory, and files inside directories where the target has a file.
 */
async function collidingUntracked(repoPath: string, target: string): Promise<string[]> {
  const [tree, index] = await Promise.all([
    runGit(['ls-tree', '-r', '-z', '--name-only', '--full-tree', target], { cwd: repoPath }),
    runGit(['ls-files', '-z', '--cached', '--full-name'], { cwd: repoPath, env: { GIT_OPTIONAL_LOCKS: '0' } }),
  ])
  const indexed = new Set(index.stdout.split('\0').filter(Boolean))
  const out = new Set<string>()
  const checkedDirs = new Set<string>()
  for (const p of tree.stdout.split('\0')) {
    if (!p || indexed.has(p)) continue
    const kind = await pathKind(join(repoPath, p))
    if (kind === 'file') out.add(p)
    else if (kind === 'dir') {
      const r = await runGit(['ls-files', '-z', '--others', '--full-name', '--', p], {
        cwd: repoPath,
        env: { GIT_LITERAL_PATHSPECS: '1' },
      })
      for (const f of r.stdout.split('\0')) if (f) out.add(f)
    }
    // An untracked file where the target needs a directory.
    for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) {
      const dir = p.slice(0, i)
      if (checkedDirs.has(dir)) continue
      checkedDirs.add(dir)
      if (!indexed.has(dir) && (await pathKind(join(repoPath, dir))) === 'file') out.add(dir)
    }
  }
  return [...out].sort()
}

async function commitTree(repoPath: string, tree: string, parents: string[], message: string): Promise<string> {
  const r = await runGit(['commit-tree', '--no-gpg-sign', ...parents.flatMap((p) => ['-p', p]), '-F', '-', tree], {
    cwd: repoPath,
    input: message,
  })
  return r.stdout.trim()
}

/** Commit the given worktree files into a standalone root commit using a temporary index. */
async function commitUntracked(repoPath: string, paths: string[], message: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gitbob-backup-'))
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') }
    await runGit(['update-index', '--add', '-z', '--stdin'], {
      cwd: repoPath,
      env,
      input: paths.map((p) => p + '\0').join(''),
      timeoutMs: INDEX_TIMEOUT,
    })
    const tree = (await runGit(['write-tree'], { cwd: repoPath, env })).stdout.trim()
    return await commitTree(repoPath, tree, [], message)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Save everything a hard reset to `target` would destroy as a stash entry: staged and unstaged
 * changes to tracked files (`git stash create`), plus untracked/ignored files the reset would
 * overwrite (as the stash's untracked-files parent). Returns null when nothing would be lost.
 */
async function backupBeforeHardReset(repoPath: string, target: string): Promise<string | null> {
  const { entries } = await runStatus(repoPath)
  if (entries.some((e) => e.kind === 'unmerged')) {
    throw new GitError(
      'GIT_FAILED',
      'Cannot back up local changes while files are conflicted. Abort the operation in progress first.',
    )
  }
  const trackedChanges = entries.some(
    (e) => (e.kind === 'ordinary' || e.kind === 'renamed') && (e.index !== '.' || e.worktree !== '.'),
  )
  const colliding = await collidingUntracked(repoPath, target)
  if (!trackedChanges && colliding.length === 0) return null

  const head = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1] })
  if (head.exitCode !== 0) {
    throw new GitError('GIT_FAILED', 'Cannot back up local changes on a branch without commits')
  }
  const headSha = head.stdout.trim()
  const message = `GitBob: backup before hard reset to ${target}`

  let stash = trackedChanges
    ? (await runGit(['stash', 'create', message], { cwd: repoPath, timeoutMs: INDEX_TIMEOUT })).stdout.trim()
    : ''
  if (colliding.length) {
    const untracked = await commitUntracked(repoPath, colliding, `untracked files: ${message}`)
    const tree = stash ? `${stash}^{tree}` : `${headSha}^{tree}`
    const treeSha = (await runGit(['rev-parse', '--verify', tree], { cwd: repoPath })).stdout.trim()
    const indexCommit = stash
      ? (await runGit(['rev-parse', '--verify', `${stash}^2`], { cwd: repoPath })).stdout.trim()
      : await commitTree(repoPath, treeSha, [headSha], `index: ${message}`)
    stash = await commitTree(repoPath, treeSha, [headSha, indexCommit, untracked], message)
  }
  if (!stash) return null
  await runGit(['stash', 'store', `--message=${message}`, stash], { cwd: repoPath })
  return stash
}

/**
 * Move the current branch (or detached HEAD) to `target`. A hard reset first stores every local
 * change it would destroy as a stash entry (see `ResetResult.backupStash`). Untracked files that
 * the target does not track are never touched by `reset --hard`.
 */
export async function reset(repoPath: string, target: string, mode: ResetMode): Promise<ResetResult> {
  if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') throw new GitError('INVALID_ARGUMENT', 'Invalid reset mode')
  const { sha } = await resolveCommit(repoPath, target)
  const backupStash = mode === 'hard' ? await backupBeforeHardReset(repoPath, sha) : null
  await runGit(['reset', '--quiet', `--${mode}`, sha, '--'], { cwd: repoPath, timeoutMs: INDEX_TIMEOUT })
  return { backupStash }
}

// ---------------------------------------------------------------------------
// Revert / cherry-pick

function assertMainline(mainline: unknown): asserts mainline is number | undefined {
  if (mainline !== undefined && (typeof mainline !== 'number' || !Number.isInteger(mainline) || mainline < 1 || mainline > 64)) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid mainline parent number')
  }
}

function mainlineArgs(commits: { sha: string; parents: string[] }[], mainline: number | undefined): string[] {
  const merges = commits.filter((c) => c.parents.length > 1)
  if (merges.length === 0) return []
  const m = mainline ?? 1
  for (const c of merges) {
    if (m > c.parents.length) {
      throw new GitError('INVALID_ARGUMENT', `Merge commit ${c.sha.slice(0, 7)} has no parent ${m}`)
    }
  }
  return ['--mainline', String(m)]
}

/**
 * Revert a commit, creating a new commit with git's default message. Merge commits are reverted
 * relative to `mainline` (default 1). On conflicts the revert is left in progress and a GitError
 * is thrown; use continueOperation/abortOperation.
 */
export async function revert(repoPath: string, sha: string, opts: { mainline?: number } = {}): Promise<void> {
  assertMainline(opts.mainline)
  const commit = await resolveCommit(repoPath, sha)
  await assertNoOperation(repoPath)
  const r = await runGit(['revert', '--no-edit', ...mainlineArgs([commit], opts.mainline), commit.sha], {
    cwd: repoPath,
    env: NO_EDITOR_ENV,
    timeoutMs: COMMIT_TIMEOUT,
    okExitCodes: ALL_EXIT_CODES,
  })
  if (r.exitCode !== 0) throw await stoppedError(repoPath, 'Revert', r)
}

/**
 * Cherry-pick commits onto HEAD in the given order. Merge commits use `mainline` (default 1).
 * On conflicts the cherry-pick is left in progress and a GitError is thrown.
 */
export async function cherryPick(repoPath: string, shas: string[], opts: { mainline?: number } = {}): Promise<void> {
  if (!Array.isArray(shas) || shas.length === 0 || shas.length > 1000) {
    throw new GitError('INVALID_ARGUMENT', 'Select between 1 and 1000 commits to cherry-pick')
  }
  assertMainline(opts.mainline)
  shas.forEach(assertSha)
  const commits = []
  for (const s of shas) commits.push(await resolveCommit(repoPath, s))
  await assertNoOperation(repoPath)
  const r = await runGit(
    ['cherry-pick', '--no-edit', ...mainlineArgs(commits, opts.mainline), ...commits.map((c) => c.sha)],
    { cwd: repoPath, env: NO_EDITOR_ENV, timeoutMs: COMMIT_TIMEOUT, okExitCodes: ALL_EXIT_CODES },
  )
  if (r.exitCode !== 0) throw await stoppedError(repoPath, 'Cherry-pick', r)
}

// ---------------------------------------------------------------------------
// Merge / rebase onto a branch

const MERGE_REF_RE = /^refs\/(heads|remotes|tags)\/[^\s~^:?*[\\]+$/

/** A full branch/tag ref that exists and points to a commit (never parsed as an option). */
async function assertMergeableRef(repoPath: string, ref: string): Promise<string> {
  if (typeof ref !== 'string' || !MERGE_REF_RE.test(ref) || ref.includes('..') || ref.endsWith('.lock')) {
    throw new GitError('INVALID_ARGUMENT', `Not a branch or tag: ${ref}`)
  }
  const r = await runGit(['rev-parse', '-q', '--verify', `${ref}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1, 128] })
  if (r.exitCode !== 0) throw new GitError('NOT_FOUND', `${ref.replace(/^refs\/(heads|remotes|tags)\//, '')} does not exist`)
  return r.stdout.trim()
}

export type MergeMode = 'ff' | 'no-ff' | 'ff-only'

/**
 * Merge a branch or tag into the current branch (`git merge --no-edit`). A conflict stops the
 * merge (the operation banner offers continue/abort). Returns whether it was a fast-forward.
 */
export async function mergeRef(repoPath: string, ref: string, opts: { mode: MergeMode }): Promise<{ fastForward: boolean; upToDate: boolean }> {
  if (opts.mode !== 'ff' && opts.mode !== 'no-ff' && opts.mode !== 'ff-only') throw new GitError('INVALID_ARGUMENT', 'Invalid merge mode')
  const target = await assertMergeableRef(repoPath, ref)
  await assertNoOperation(repoPath)
  const before = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1, 128] })
  // Same wording as git's default message, without the refs/ prefix the full ref would leave in it.
  const kind = ref.startsWith('refs/heads/') ? 'branch' : ref.startsWith('refs/remotes/') ? 'remote-tracking branch' : 'tag'
  const name = ref.replace(/^refs\/(heads|remotes|tags)\//, '')
  const current = (await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: repoPath, okExitCodes: [0, 1] })).stdout.trim()
  const into = current && current !== 'main' && current !== 'master' ? ` into ${current}` : ''
  const r = await runGit(['merge', '--no-edit', `--${opts.mode}`, '-m', `Merge ${kind} '${name}'${into}`, ref], {
    cwd: repoPath,
    env: NO_EDITOR_ENV,
    timeoutMs: COMMIT_TIMEOUT,
    okExitCodes: ALL_EXIT_CODES,
  })
  if (r.exitCode !== 0) throw await stoppedError(repoPath, 'Merge', r)
  const after = (await runGit(['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim()
  const upToDate = before.exitCode === 0 && before.stdout.trim() === after
  return { fastForward: !upToDate && after === target, upToDate }
}

/** Commits on the current branch that a rebase onto `ref` would rewrite. */
export async function commitsToRebase(repoPath: string, ref: string): Promise<number> {
  if (SHA_RE.test(ref)) await resolveCommit(repoPath, ref)
  else await assertMergeableRef(repoPath, ref)
  const r = await runGit(['rev-list', '--count', `${ref}..HEAD`], { cwd: repoPath })
  return Number(r.stdout.trim()) || 0
}

/** Rebase the current branch onto a branch, tag or commit (`git rebase <ref>`). A conflict stops it. */
export async function rebaseOnto(repoPath: string, ref: string): Promise<void> {
  if (SHA_RE.test(ref)) await resolveCommit(repoPath, ref)
  else await assertMergeableRef(repoPath, ref)
  await assertNoOperation(repoPath)
  const branch = await runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: repoPath, okExitCodes: [0, 1] })
  if (branch.exitCode !== 0) throw new GitError('INVALID_ARGUMENT', 'Check out a branch before rebasing')
  const r = await runGit(['rebase', ref], { cwd: repoPath, env: NO_EDITOR_ENV, timeoutMs: COMMIT_TIMEOUT, okExitCodes: ALL_EXIT_CODES })
  if (r.exitCode !== 0) throw await stoppedError(repoPath, 'Rebase', r)
}

/** Change only the message of HEAD (`commit --amend --only`): staged changes are left alone. */
export async function rewordHead(repoPath: string, message: string): Promise<void> {
  if (typeof message !== 'string' || !message.trim() || message.includes('\0')) throw new GitError('INVALID_ARGUMENT', 'The commit message is empty')
  await assertNoOperation(repoPath)
  await runGit(['commit', '--amend', '--only', '--allow-empty', '--no-verify', '--cleanup=strip', '-F', '-'], {
    cwd: repoPath,
    env: NO_EDITOR_ENV,
    input: message,
    timeoutMs: COMMIT_TIMEOUT,
  })
}

// ---------------------------------------------------------------------------
// Continue / abort / skip

async function currentOperation(repoPath: string, allowed: readonly GitOperation[], verb: string): Promise<GitOperation> {
  const op = await getOperation(repoPath)
  if (!op) throw new GitError('INVALID_ARGUMENT', 'No merge, rebase, cherry-pick or revert is in progress')
  if (!allowed.includes(op)) throw new GitError('INVALID_ARGUMENT', `Cannot ${verb} a ${LABEL[op].toLowerCase()}`)
  return op
}

async function runOperationCommand(repoPath: string, op: GitOperation, args: string[]): Promise<void> {
  const r = await runGit(args, { cwd: repoPath, env: NO_EDITOR_ENV, timeoutMs: COMMIT_TIMEOUT, okExitCodes: ALL_EXIT_CODES })
  if (r.exitCode !== 0) throw await stoppedError(repoPath, LABEL[op], r)
}

/**
 * Continue the operation in progress after conflicts were resolved and staged. Messages are
 * kept as prepared by git (no editor). Refuses while files are still conflicted.
 */
export async function continueOperation(repoPath: string): Promise<{ operation: GitOperation }> {
  const op = await currentOperation(repoPath, ['merge', 'rebase', 'cherry-pick', 'revert'], 'continue')
  const conflicts = await conflictedPaths(repoPath)
  if (conflicts.length) {
    throw new GitError('INVALID_ARGUMENT', `Resolve and stage the conflicted files first: ${conflicts.join(', ')}`)
  }
  const args = op === 'merge' ? ['commit', '--no-edit'] : [op, '--continue']
  await runOperationCommand(repoPath, op, args)
  return { operation: op }
}

/** Abort the operation in progress, restoring the state before it started. The UI must confirm first. */
export async function abortOperation(repoPath: string): Promise<{ operation: GitOperation }> {
  const op = await currentOperation(repoPath, ['merge', 'rebase', 'cherry-pick', 'revert'], 'abort')
  await runOperationCommand(repoPath, op, [op, '--abort'])
  return { operation: op }
}

/** Skip the current commit of a rebase, cherry-pick or revert (its changes are dropped). */
export async function skipOperation(repoPath: string): Promise<{ operation: GitOperation }> {
  const op = await currentOperation(repoPath, ['rebase', 'cherry-pick', 'revert'], 'skip')
  await runOperationCommand(repoPath, op, [op, '--skip'])
  return { operation: op }
}

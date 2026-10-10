import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { assertValidBranchName } from './branches'
import { GitError } from './errors'
import { runGit } from './runner'
import type { WorktreeInfo } from '@shared/types'
export type { WorktreeInfo }


export interface AddWorktreeOptions {
  /** Check out this existing local branch (it must not be checked out elsewhere). */
  branch?: string
  /** Create this new branch at `startPoint` (default HEAD) and check it out. */
  newBranch?: string
  /** Commit for `newBranch` or `detach`. */
  startPoint?: string
  /** Detached HEAD at `startPoint` (default HEAD). */
  detach?: boolean
}

const SHA_RE = /^[0-9a-f]{4,64}$/i
const ZERO_SHA_RE = /^0+$/
const WORKTREE_TIMEOUT = 5 * 60_000

/** Parse `git worktree list --porcelain` (NUL- or newline-separated). The first record is the main worktree. */
export function parseWorktreeList(stdout: string, sep: '\0' | '\n'): Omit<WorktreeInfo, 'isCurrent'>[] {
  const out: Omit<WorktreeInfo, 'isCurrent'>[] = []
  let cur: Omit<WorktreeInfo, 'isCurrent'> | null = null
  for (const attr of stdout.split(sep)) {
    if (attr === '') {
      cur = null
      continue
    }
    const sp = attr.indexOf(' ')
    const key = sp === -1 ? attr : attr.slice(0, sp)
    const value = sp === -1 ? '' : attr.slice(sp + 1)
    if (key === 'worktree') {
      cur = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        isMain: out.length === 0,
      }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (key === 'HEAD') cur.head = ZERO_SHA_RE.test(value) ? null : value
    else if (key === 'branch') cur.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
    else if (key === 'detached') cur.detached = true
    else if (key === 'bare') cur.bare = true
    else if (key === 'locked') cur.locked = true
    else if (key === 'prunable') cur.prunable = true
  }
  return out
}

async function real(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return resolve(p)
  }
}

async function currentRoot(repoPath: string): Promise<string> {
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: repoPath, okExitCodes: [0, 128] })
  if (top.exitCode === 0 && top.stdout.trim()) return real(top.stdout.trim())
  // Bare repository: the main "worktree" entry is the git dir itself.
  const gitDir = await runGit(['rev-parse', '--absolute-git-dir'], { cwd: repoPath })
  return real(gitDir.stdout.trim())
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  let r = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath, okExitCodes: [0, 129] })
  let sep: '\0' | '\n' = '\0'
  if (r.exitCode === 129) {
    // git < 2.36 has no -z; paths containing newlines are then ambiguous.
    r = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath })
    sep = '\n'
  }
  const root = await currentRoot(repoPath)
  const list = parseWorktreeList(r.stdout, sep)
  return Promise.all(list.map(async (w) => ({ ...w, isCurrent: (await real(w.path)) === root })))
}

function assertAbsolutePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || /[\0\r\n]/.test(path) || !isAbsolute(path)) {
    throw new GitError('INVALID_ARGUMENT', 'Worktree path must be an absolute path')
  }
}

async function assertUsableTarget(path: string): Promise<void> {
  let st
  try {
    st = await stat(path)
  } catch {
    return
  }
  if (!st.isDirectory() || (await readdir(path)).length > 0) {
    throw new GitError('INVALID_ARGUMENT', `${path} already exists and is not an empty directory`)
  }
}

async function resolveStartPoint(repoPath: string, startPoint: string | undefined): Promise<string[]> {
  if (startPoint === undefined) return []
  if (typeof startPoint !== 'string' || !SHA_RE.test(startPoint)) throw new GitError('INVALID_ARGUMENT', 'Invalid start point')
  const r = await runGit(['rev-parse', '-q', '--verify', `${startPoint}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1, 128] })
  if (r.exitCode !== 0) throw new GitError('NOT_FOUND', `Commit ${startPoint} not found`)
  return [r.stdout.trim()]
}

async function branchExists(repoPath: string, name: string): Promise<boolean> {
  const r = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repoPath, okExitCodes: [0, 1] })
  return r.exitCode === 0
}

/** Create a linked worktree at `path` (absolute; must not exist or be an empty directory). */
export async function addWorktree(repoPath: string, path: string, opts: AddWorktreeOptions): Promise<WorktreeInfo> {
  assertAbsolutePath(path)
  const modes = [opts.branch !== undefined, opts.newBranch !== undefined, opts.detach === true].filter(Boolean).length
  if (modes !== 1) throw new GitError('INVALID_ARGUMENT', 'Choose exactly one of: existing branch, new branch, detached HEAD')
  await assertUsableTarget(path)

  const args = ['worktree', 'add', '--no-guess-remote']
  if (opts.branch !== undefined) {
    if (opts.startPoint !== undefined) throw new GitError('INVALID_ARGUMENT', 'A start point cannot be used with an existing branch')
    await assertValidBranchName(repoPath, opts.branch)
    if (!(await branchExists(repoPath, opts.branch))) throw new GitError('NOT_FOUND', `Branch ${opts.branch} does not exist`)
    args.push('--', path, opts.branch)
  } else if (opts.newBranch !== undefined) {
    await assertValidBranchName(repoPath, opts.newBranch)
    if (await branchExists(repoPath, opts.newBranch)) {
      throw new GitError('INVALID_ARGUMENT', `A branch named "${opts.newBranch}" already exists`)
    }
    args.push('-b', opts.newBranch, '--', path, ...(await resolveStartPoint(repoPath, opts.startPoint)))
  } else {
    args.push('--detach', '--', path, ...(await resolveStartPoint(repoPath, opts.startPoint)))
  }
  const r = await runGit(args, { cwd: repoPath, timeoutMs: WORKTREE_TIMEOUT, okExitCodes: [0, 128, 255] })
  if (r.exitCode !== 0) {
    const first = (r.stderr.split('\n').find((l) => /^(fatal|error): /.test(l)) ?? r.stderr.split('\n')[0] ?? '').replace(
      /^(fatal|error): /,
      '',
    )
    throw new GitError('GIT_FAILED', first || 'git worktree add failed', { detail: r.stderr, exitCode: r.exitCode })
  }
  const target = await real(path)
  const added = (await listWorktrees(repoPath)).find((w) => w.path === path || w.path === target)
  if (!added) throw new GitError('INTERNAL', 'The new worktree was not found after creating it')
  return added
}

async function findWorktree(repoPath: string, path: string): Promise<WorktreeInfo> {
  assertAbsolutePath(path)
  const target = await real(path)
  const list = await listWorktrees(repoPath)
  for (const w of list) if (w.path === path || (await real(w.path)) === target) return w
  throw new GitError('NOT_FOUND', `${path} is not a worktree of this repository`)
}

/**
 * Remove a linked worktree. Without `force` git refuses when it has modified or untracked files;
 * with `force` those files are deleted, so the UI must confirm first. Locked worktrees are refused.
 */
export async function removeWorktree(repoPath: string, path: string, opts: { force: boolean }): Promise<void> {
  const w = await findWorktree(repoPath, path)
  if (w.isMain) throw new GitError('INVALID_ARGUMENT', 'The main worktree cannot be removed')
  if (w.isCurrent) throw new GitError('INVALID_ARGUMENT', 'Cannot remove the worktree that is currently open')
  if (w.locked) throw new GitError('INVALID_ARGUMENT', 'The worktree is locked; unlock it first')
  const r = await runGit(['worktree', 'remove', ...(opts.force ? ['--force'] : []), '--', w.path], {
    cwd: repoPath,
    timeoutMs: WORKTREE_TIMEOUT,
    okExitCodes: [0, 128],
  })
  if (r.exitCode !== 0) {
    if (/contains modified or untracked files/.test(r.stderr)) {
      throw new GitError('GIT_FAILED', 'The worktree has modified or untracked files. Remove it with force to delete them.', {
        detail: r.stderr,
        exitCode: r.exitCode,
      })
    }
    throw new GitError('GIT_FAILED', r.stderr.split('\n')[0]?.replace(/^(fatal|error): /, '') || 'git worktree remove failed', {
      detail: r.stderr,
      exitCode: r.exitCode,
    })
  }
}

/** Remove administrative data of worktrees whose directories are gone. Returns the pruned worktree ids. */
export async function pruneWorktrees(repoPath: string): Promise<{ pruned: string[] }> {
  const r = await runGit(['worktree', 'prune', '--verbose'], { cwd: repoPath })
  const pruned: string[] = []
  for (const line of `${r.stderr}\n${r.stdout}`.split('\n')) {
    const m = /^Removing worktrees\/(.+?): /.exec(line)
    if (m?.[1]) pruned.push(m[1])
  }
  return { pruned }
}

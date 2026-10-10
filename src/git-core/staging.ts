import { GitError } from './errors'
import { LITERAL_PATHSPECS_ENV, PATHSPEC_STDIN, pathspecInput, resolveRepoPath, validateRepoPaths } from './paths'
import { runGit } from './runner'
import { runStatus } from './status'

/** Index-writing commands can wait on hooks/filters and large indexes; allow more than the default. */
const INDEX_TIMEOUT = 120_000

async function isUnborn(repoPath: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1] })
  return r.exitCode !== 0
}

/** Run a command that reads its pathspecs NUL-separated from stdin (no argv length limits). */
function runWithPathspecs(repoPath: string, args: string[], paths: readonly string[]): Promise<unknown> {
  return runGit([...args, ...PATHSPEC_STDIN], {
    cwd: repoPath,
    input: pathspecInput(paths),
    env: LITERAL_PATHSPECS_ENV,
    timeoutMs: INDEX_TIMEOUT,
  })
}

/** Stage the given paths, including deletions. Also marks conflicted paths as resolved. */
export async function stagePaths(repoPath: string, paths: string[]): Promise<void> {
  validateRepoPaths(repoPath, paths)
  if (paths.length === 0) return
  await runWithPathspecs(repoPath, ['add', '-A'], paths)
}

export async function stageAll(repoPath: string): Promise<void> {
  await runGit(['add', '-A'], { cwd: repoPath, timeoutMs: INDEX_TIMEOUT })
}

/**
 * Staged renames involving any of `paths`, as index-vs-HEAD pairs. Rename detection
 * needs both sides, so this diffs the whole index rather than just `paths`.
 */
async function stagedRenameSources(repoPath: string, paths: readonly string[]): Promise<string[]> {
  const { stdout } = await runGit(
    ['diff', '--cached', '--name-status', '-z', '-M', '--no-ext-diff', '--no-relative', 'HEAD', '--'],
    { cwd: repoPath, timeoutMs: INDEX_TIMEOUT },
  )
  const wanted = new Set(paths)
  const extra: string[] = []
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const status = tokens[i++]
    if (!status) continue
    if (status[0] === 'R' || status[0] === 'C') {
      const from = tokens[i++] ?? ''
      const to = tokens[i++] ?? ''
      // Unstaging either side of a rename unstages both, so the old path does not stay staged as deleted.
      if (status[0] === 'R' && (wanted.has(to) || wanted.has(from))) extra.push(from, to)
    } else {
      i++
    }
  }
  return extra
}

/**
 * Remove the given paths from the index, restoring the HEAD version there (worktree untouched).
 * On an unborn branch the paths are simply removed from the index.
 */
export async function unstagePaths(repoPath: string, paths: string[]): Promise<void> {
  validateRepoPaths(repoPath, paths)
  if (paths.length === 0) return
  if (await isUnborn(repoPath)) {
    await runWithPathspecs(repoPath, ['rm', '--cached', '-r', '-q', '-f', '--ignore-unmatch'], paths)
    return
  }
  const all = [...new Set([...paths, ...(await stagedRenameSources(repoPath, paths))])]
  await runWithPathspecs(repoPath, ['reset', '-q', 'HEAD'], all)
}

export async function unstageAll(repoPath: string): Promise<void> {
  if (await isUnborn(repoPath)) {
    await runGit(['rm', '--cached', '-r', '-q', '-f', '--ignore-unmatch', '--', '.'], {
      cwd: repoPath,
      timeoutMs: INDEX_TIMEOUT,
    })
    return
  }
  await runGit(['reset', '-q', 'HEAD', '--'], { cwd: repoPath, timeoutMs: INDEX_TIMEOUT })
}

export interface DiscardOptions {
  /** Move an untracked file to the OS trash (recoverable). Called with an absolute path. */
  trash: (absolutePath: string) => Promise<void>
}

/**
 * Discard worktree changes for `paths`. The index is never modified: tracked files are
 * restored from the index (their staged content), and untracked files are handed to
 * `opts.trash` instead of being deleted. Paths without changes are ignored.
 */
export async function discardPaths(repoPath: string, paths: string[], opts: DiscardOptions): Promise<void> {
  validateRepoPaths(repoPath, paths)
  if (paths.length === 0) return

  // Exact per-path state; renames disabled so each entry names one concrete path.
  const { entries } = await runStatus(repoPath, { renames: false })
  const wanted = new Set(paths.map((p) => p.replace(/[/\\]+$/, '')))
  const matches = (p: string): boolean => {
    if (wanted.has(p)) return true
    // A directory argument covers everything below it.
    for (let idx = p.lastIndexOf('/'); idx > 0; idx = p.lastIndexOf('/', idx - 1)) {
      if (wanted.has(p.slice(0, idx))) return true
    }
    return false
  }

  const restore: string[] = []
  const untracked: string[] = []
  for (const e of entries) {
    if (!matches(e.path)) continue
    if (e.kind === 'unmerged') {
      throw new GitError('INVALID_ARGUMENT', `Cannot discard changes of a conflicted file: ${e.path}`)
    }
    if (e.submodule && e.worktree !== '.') {
      throw new GitError('INVALID_ARGUMENT', `Discarding changes inside a submodule is not supported: ${e.path}`)
    }
    if (e.kind === 'untracked') untracked.push(e.path)
    else if (e.kind === 'ordinary' && e.worktree !== '.') restore.push(e.path)
  }

  if (restore.length) await runWithPathspecs(repoPath, ['restore', '--worktree'], restore)
  for (const p of untracked) await opts.trash(resolveRepoPath(repoPath, p))
}

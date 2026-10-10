import type { FileChange } from '@shared/types'
import { parseNameStatus, parseNumstat } from './details'
import { GitError } from './errors'
import { LITERAL_PATHSPECS_ENV, PATHSPEC_STDIN, pathspecInput, validateRepoPaths } from './paths'
import { runGit } from './runner'
import { runStatus } from './status'
import type { StashEntry } from '@shared/types'
export type { StashEntry }


const SHA_RE = /^[0-9a-f]{4,64}$/i
const STASH_TIMEOUT = 120_000
const ALL_EXIT_CODES = Array.from({ length: 256 }, (_, i) => i)

/** Parse a stash reflog subject into branch and message. */
export function parseStashSubject(subject: string): { branch: string | null; message: string } {
  const named = /^On ([^:]+): (.*)$/s.exec(subject)
  if (named) return { branch: named[1] === '(no branch)' ? null : (named[1] ?? null), message: named[2] ?? '' }
  const wip = /^WIP on ([^:]+): /.exec(subject)
  if (wip) return { branch: wip[1] === '(no branch)' ? null : (wip[1] ?? null), message: subject }
  return { branch: null, message: subject }
}

/** Parse `git log -g -z --format=%H%x00%gs%x00%ct refs/stash`. */
export function parseStashList(stdout: string): StashEntry[] {
  const tokens = stdout.split('\0')
  const out: StashEntry[] = []
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const sha = (tokens[i] ?? '').replace(/^\n/, '')
    if (!sha) continue
    const subject = tokens[i + 1] ?? ''
    const index = out.length
    out.push({ index, ref: `stash@{${index}}`, sha, ...parseStashSubject(subject), time: Number(tokens[i + 2]) || 0 })
  }
  return out
}

async function hasStashRef(repoPath: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '-q', '--verify', 'refs/stash'], { cwd: repoPath, okExitCodes: [0, 1] })
  return r.exitCode === 0
}

export async function listStashes(repoPath: string): Promise<StashEntry[]> {
  if (!(await hasStashRef(repoPath))) return []
  const { stdout } = await runGit(['log', '-g', '-z', '--no-abbrev-commit', '--format=%H%x00%gs%x00%ct', 'refs/stash', '--'], {
    cwd: repoPath,
  })
  return parseStashList(stdout)
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 100_000) {
    throw new GitError('INVALID_ARGUMENT', `Invalid stash index: ${String(index)}`)
  }
}

/**
 * Resolve `stash@{index}` to its commit. When `expectedSha` is given the entry must still be
 * that commit, so a stale UI index can never apply or drop a different stash.
 */
async function resolveStash(repoPath: string, index: number, expectedSha?: string): Promise<string> {
  assertIndex(index)
  if (expectedSha !== undefined && !SHA_RE.test(expectedSha)) throw new GitError('INVALID_ARGUMENT', 'Invalid stash id')
  const entry = (await listStashes(repoPath))[index]
  if (!entry) throw new GitError('NOT_FOUND', `Stash stash@{${index}} does not exist`)
  if (expectedSha !== undefined && !entry.sha.startsWith(expectedSha.toLowerCase())) {
    throw new GitError('INVALID_ARGUMENT', `stash@{${index}} has changed; refresh and try again`)
  }
  return entry.sha
}

function combinedOutput(r: { stdout: string; stderr: string }): string {
  return [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n')
}

function firstMeaningfulLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').replace(/^(fatal|error): /, '')
}

/**
 * Stash local changes (`git stash push`). Returns `created: false` when there was nothing to
 * stash. Paths (optional) limit the stash and are matched literally.
 */
export async function createStash(
  repoPath: string,
  opts: { message?: string; includeUntracked: boolean; keepIndex?: boolean; paths?: string[] },
): Promise<{ created: boolean }> {
  if (opts.message !== undefined && (typeof opts.message !== 'string' || opts.message.includes('\0'))) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid stash message')
  }
  const paths = opts.paths ?? []
  validateRepoPaths(repoPath, paths)

  const head = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1] })
  if (head.exitCode !== 0) throw new GitError('GIT_FAILED', 'Cannot stash before the first commit')
  const before = await runGit(['rev-parse', '-q', '--verify', 'refs/stash'], { cwd: repoPath, okExitCodes: [0, 1] })
  const message = opts.message?.trim()
  const args = [
    'stash',
    'push',
    '--quiet',
    ...(opts.includeUntracked ? ['--include-untracked'] : []),
    ...(opts.keepIndex ? ['--keep-index'] : []),
    // A single argv element: the message can never be read as an option.
    ...(message ? [`--message=${message}`] : []),
    ...(paths.length ? PATHSPEC_STDIN : []),
  ]
  const r = await runGit(args, {
    cwd: repoPath,
    timeoutMs: STASH_TIMEOUT,
    okExitCodes: ALL_EXIT_CODES,
    ...(paths.length ? { input: pathspecInput(paths), env: LITERAL_PATHSPECS_ENV } : {}),
  })
  const detail = combinedOutput(r)
  if (r.exitCode !== 0) {
    if (/needs merge|unmerged/i.test(detail)) {
      throw new GitError('GIT_FAILED', 'Cannot stash while there are unresolved conflicts', { detail, exitCode: r.exitCode })
    }
    throw new GitError('GIT_FAILED', firstMeaningfulLine(detail) || `git stash exited with code ${r.exitCode}`, {
      detail,
      exitCode: r.exitCode,
    })
  }
  const after = await runGit(['rev-parse', '-q', '--verify', 'refs/stash'], { cwd: repoPath, okExitCodes: [0, 1] })
  return { created: after.exitCode === 0 && after.stdout.trim() !== before.stdout.trim() }
}

/**
 * Apply (or pop) a stash. On conflicts git leaves the conflicted files in the working tree and
 * keeps the stash entry (also for pop); this is reported as a GitError so the UI can tell the
 * user to resolve the conflicts and drop the stash manually.
 */
export async function applyStash(
  repoPath: string,
  index: number,
  opts: { pop: boolean; restoreIndex?: boolean; expectedSha?: string },
): Promise<void> {
  const sha = await resolveStash(repoPath, index, opts.expectedSha)
  const r = await runGit(
    ['stash', opts.pop ? 'pop' : 'apply', ...(opts.restoreIndex ? ['--index'] : []), `stash@{${index}}`],
    { cwd: repoPath, timeoutMs: STASH_TIMEOUT, okExitCodes: ALL_EXIT_CODES },
  )
  if (r.exitCode === 0) return
  const detail = combinedOutput(r)
  const { entries } = await runStatus(repoPath)
  const conflicted = entries.filter((e) => e.kind === 'unmerged').map((e) => e.path)
  if (conflicted.length || /CONFLICT/.test(detail)) {
    throw new GitError(
      'GIT_FAILED',
      `Applying stash@{${index}} produced conflicts in ${conflicted.length ? conflicted.join(', ') : 'some files'}. ` +
        `Resolve them; the stash (${sha.slice(0, 7)}) was kept.`,
      { detail, exitCode: r.exitCode },
    )
  }
  if (/would be overwritten|already exists, no checkout/i.test(detail)) {
    throw new GitError(
      'GIT_FAILED',
      `Your local changes conflict with stash@{${index}}. Commit or stash them first; the stash was kept.`,
      { detail, exitCode: r.exitCode },
    )
  }
  throw new GitError('GIT_FAILED', firstMeaningfulLine(detail) || `git stash exited with code ${r.exitCode}`, {
    detail,
    exitCode: r.exitCode,
  })
}

/** Drop a stash entry. Destructive: the UI must confirm first. */
export async function dropStash(repoPath: string, index: number, opts: { expectedSha?: string } = {}): Promise<void> {
  await resolveStash(repoPath, index, opts.expectedSha)
  await runGit(['stash', 'drop', '--quiet', `stash@{${index}}`], { cwd: repoPath })
}

async function diffFiles(repoPath: string, range: string[]): Promise<FileChange[]> {
  const common = ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--no-ext-diff', ...range]
  const [ns, num] = await Promise.all([
    runGit([...common, '--name-status', '--'], { cwd: repoPath }),
    runGit([...common, '--numstat', '--'], { cwd: repoPath }),
  ])
  const stats = parseNumstat(num.stdout)
  return parseNameStatus(ns.stdout).map((f) => ({
    ...f,
    additions: stats.get(f.path)?.additions ?? null,
    deletions: stats.get(f.path)?.deletions ?? null,
  }))
}

/**
 * Files changed by a stash relative to the commit it was created on. Untracked files stored
 * in the stash (its third parent, from `--include-untracked`) are included as additions.
 */
export async function getStashFiles(repoPath: string, index: number, opts: { expectedSha?: string } = {}): Promise<FileChange[]> {
  const sha = await resolveStash(repoPath, index, opts.expectedSha)
  const tracked = await diffFiles(repoPath, [`${sha}^1`, sha])
  const u = await runGit(['rev-parse', '-q', '--verify', `${sha}^3^{commit}`], { cwd: repoPath, okExitCodes: [0, 1] })
  if (u.exitCode !== 0) return tracked
  const untracked = await diffFiles(repoPath, ['--root', u.stdout.trim()])
  const seen = new Set(tracked.map((f) => f.path))
  return [...tracked, ...untracked.filter((f) => !seen.has(f.path))]
}

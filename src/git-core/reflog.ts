import { assertValidBranchName } from './branches'
import { GitError } from './errors'
import { runGit } from './runner'
import type { ReflogEntry } from '@shared/types'
export type { ReflogEntry }


const MAX_LIMIT = 10_000

/** Split a reflog subject ("checkout: moving from a to b") into action and message. */
export function splitReflogSubject(subject: string): { action: string; message: string } {
  const i = subject.indexOf(': ')
  if (i <= 0) return { action: subject, message: '' }
  return { action: subject.slice(0, i), message: subject.slice(i + 2) }
}

/**
 * Parse `git log -g -z --date=unix --format=%H%x00%gd%x00%gs` output. With `--date=unix` the
 * `%gd` selector carries the entry's timestamp (`ref@{1700000000}`); the index selector is
 * rebuilt from the entry's position (entries are listed newest first, `@{0}` first).
 */
export function parseReflog(stdout: string, ref: string): ReflogEntry[] {
  const tokens = stdout.split('\0')
  const out: ReflogEntry[] = []
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const sha = (tokens[i] ?? '').replace(/^\n/, '')
    if (!sha) continue
    const time = /@\{(\d+)\}$/.exec(tokens[i + 1] ?? '')
    out.push({
      sha,
      selector: `${ref}@{${out.length}}`,
      ...splitReflogSubject(tokens[i + 2] ?? ''),
      time: time ? Number(time[1]) : 0,
    })
  }
  return out
}

async function assertValidReflogRef(repoPath: string, ref: string): Promise<void> {
  if (ref === 'HEAD') return
  if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
    await assertValidBranchName(repoPath, ref.slice('refs/heads/'.length))
    return
  }
  throw new GitError('INVALID_ARGUMENT', `Reflog is only available for HEAD and local branches: ${String(ref)}`)
}

/** Reflog of HEAD or a local branch, newest first. Returns [] when the ref or its reflog does not exist. */
export async function getReflog(repoPath: string, ref = 'HEAD', limit = 200): Promise<ReflogEntry[]> {
  await assertValidReflogRef(repoPath, ref)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new GitError('INVALID_ARGUMENT', `Reflog limit must be between 1 and ${MAX_LIMIT}`)
  }
  // Unborn HEAD or missing branch: no reflog to show.
  const exists = await runGit(['rev-parse', '-q', '--verify', `${ref}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1] })
  if (exists.exitCode !== 0) return []
  const hasLog = await runGit(['reflog', 'exists', ref], { cwd: repoPath, okExitCodes: [0, 1] })
  if (hasLog.exitCode !== 0) return []
  const { stdout } = await runGit(
    ['log', '-g', '-z', '--no-abbrev-commit', '--date=unix', `--max-count=${limit}`, '--format=%H%x00%gd%x00%gs', ref, '--'],
    { cwd: repoPath },
  )
  return parseReflog(stdout, ref)
}

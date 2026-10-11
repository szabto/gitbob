import type { CommitResult } from '@shared/types'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GitError } from './errors'
import { runGit } from './runner'

/** Hooks (pre-commit, commit-msg, ...) can run linters/tests; give them time. */
const COMMIT_TIMEOUT = 5 * 60_000
const ALL_EXIT_CODES = Array.from({ length: 256 }, (_, i) => i)

/**
 * Create a commit from the index (or amend HEAD). The message is passed on stdin
 * (`--file=-`), never on the command line. Hooks run normally. Git's default
 * cleanup mode for non-editor messages applies (or the user's `commit.cleanup`).
 */
export async function createCommit(repoPath: string, message: string, opts: { amend: boolean }): Promise<CommitResult> {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new GitError('INVALID_ARGUMENT', 'Commit message must not be empty')
  }
  const args = ['commit', '--file=-', ...(opts.amend ? ['--amend'] : [])]
  const r = await runGit(args, {
    cwd: repoPath,
    input: message,
    timeoutMs: COMMIT_TIMEOUT,
    // Never open an editor, even if a hook or config asks for one.
    env: { GIT_EDITOR: 'true' },
    okExitCodes: ALL_EXIT_CODES,
  })
  if (r.exitCode !== 0) {
    // "nothing to commit" is reported on stdout with an empty stderr.
    const detail = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n')
    const first = detail.split('\n').find((l) => l.trim()) ?? ''
    throw new GitError('GIT_FAILED', first.replace(/^(fatal|error): /, '') || `git commit exited with code ${r.exitCode}`, {
      detail,
      exitCode: r.exitCode,
    })
  }
  const head = await runGit(['log', '-1', '-z', '--format=%H%x00%s', 'HEAD', '--'], { cwd: repoPath })
  const [sha = '', summary = ''] = head.stdout.split('\0')
  return { sha, summary }
}

/** Full raw message of HEAD with trailing whitespace removed; null on an unborn branch. */
export async function getLastCommitMessage(repoPath: string): Promise<string | null> {
  const rev = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1] })
  if (rev.exitCode !== 0) return null
  const r = await runGit(['log', '-1', '--format=%B', rev.stdout.trim(), '--'], { cwd: repoPath })
  return r.stdout.replace(/\s+$/, '')
}

const MAX_TEMPLATE_BYTES = 64 * 1024

/**
 * The message template configured with `commit.template` (git's `--path` expansion, relative paths
 * resolved against the repository), with `#` comment lines removed. Null when none is set or it
 * can't be read.
 */
export async function getCommitTemplate(repoPath: string): Promise<string | null> {
  const r = await runGit(['config', '--path', '--get', 'commit.template'], { cwd: repoPath, okExitCodes: [0, 1] })
  const configured = r.stdout.trim()
  if (r.exitCode !== 0 || !configured) return null
  try {
    const file = resolve(repoPath, configured)
    const st = await stat(file)
    if (!st.isFile() || st.size > MAX_TEMPLATE_BYTES) return null
    const text = (await readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter((l) => !l.startsWith('#'))
      .join('\n')
      .replace(/\s+$/, '')
    return text || null
  } catch {
    return null
  }
}

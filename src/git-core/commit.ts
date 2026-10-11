import type { CommitResult } from '@shared/types'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LITERAL_PATHSPECS_ENV, PATHSPEC_STDIN, pathspecInput, validateRepoPaths } from './paths'
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
export async function createCommit(repoPath: string, message: string, opts: { amend: boolean; paths?: string[] }): Promise<CommitResult> {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new GitError('INVALID_ARGUMENT', 'Commit message must not be empty')
  }
  const paths = opts.paths ?? []
  let r
  if (paths.length === 0) {
    const args = ['commit', '--file=-', ...(opts.amend ? ['--amend'] : [])]
    r = await runGit(args, {
      cwd: repoPath,
      input: message,
      timeoutMs: COMMIT_TIMEOUT,
      // Never open an editor, even if a hook or config asks for one.
      env: { GIT_EDITOR: 'true' },
      okExitCodes: ALL_EXIT_CODES,
    })
  } else {
    r = await commitOnly(repoPath, message, paths, opts.amend)
  }
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

/**
 * Commit exactly `paths` as they are in the working tree (`git commit --only`), leaving every
 * other staged or unstaged change as it was. New files among them are added first.
 */
async function commitOnly(repoPath: string, message: string, paths: string[], amend: boolean) {
  validateRepoPaths(repoPath, paths)
  // ls-files has no --pathspec-from-file; the validated paths go after `--`, matched literally.
  const untracked = await runGit(['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths], {
    cwd: repoPath,
    env: LITERAL_PATHSPECS_ENV,
  })
  const newFiles = untracked.stdout.split('\0').filter(Boolean)
  if (newFiles.length) {
    await runGit(['add', ...PATHSPEC_STDIN], { cwd: repoPath, input: pathspecInput(newFiles), env: LITERAL_PATHSPECS_ENV, timeoutMs: COMMIT_TIMEOUT })
  }
  // The pathspec list goes on stdin, so the message comes from a private temp file.
  const dir = await mkdtemp(join(tmpdir(), 'gitbob-msg-'))
  try {
    const msgFile = join(dir, 'COMMIT_MSG')
    await writeFile(msgFile, message, { mode: 0o600 })
    const r = await runGit(['commit', '--only', `--file=${msgFile}`, ...(amend ? ['--amend'] : []), ...PATHSPEC_STDIN], {
      cwd: repoPath,
      input: pathspecInput(paths),
      timeoutMs: COMMIT_TIMEOUT,
      env: { GIT_EDITOR: 'true', ...LITERAL_PATHSPECS_ENV },
      okExitCodes: ALL_EXIT_CODES,
    })
    if (r.exitCode !== 0 && newFiles.length) {
      // Don't leave the files we added staged when the commit didn't happen.
      await runGit(['reset', '-q', ...PATHSPEC_STDIN], { cwd: repoPath, input: pathspecInput(newFiles), env: LITERAL_PATHSPECS_ENV, okExitCodes: ALL_EXIT_CODES })
    }
    return r
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

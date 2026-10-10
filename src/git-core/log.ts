import type { CommitPage, CommitSummary } from '@shared/types'
import { getHead } from './refs'
import { runGit } from './runner'

/** Fields emitted per commit, NUL separated; with -z commits are also NUL separated. */
const LOG_FIELDS = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s'] as const
export const LOG_FORMAT = LOG_FIELDS.join('%x00')
const FIELD_COUNT = LOG_FIELDS.length

/** Parse `git log -z --format=LOG_FORMAT` output. */
export function parseLog(stdout: string): CommitSummary[] {
  if (!stdout) return []
  // Trailing newline/NUL handling: git terminates each record with NUL under -z (except possibly the last).
  const tokens = stdout.replace(/\0?\n?$/, '').split('\0')
  if (tokens.length % FIELD_COUNT !== 0) {
    throw new Error(`Malformed git log output: ${tokens.length} fields is not a multiple of ${FIELD_COUNT}`)
  }
  const commits: CommitSummary[] = []
  for (let i = 0; i < tokens.length; i += FIELD_COUNT) {
    const [sha, parents, an, ae, at, cn, ce, ct, subject] = tokens.slice(i, i + FIELD_COUNT) as string[]
    commits.push({
      sha: sha!.replace(/^\n/, ''),
      parents: parents ? parents.split(' ') : [],
      authorName: an!,
      authorEmail: ae!,
      authorTime: Number(at),
      committerName: cn!,
      committerEmail: ce!,
      commitTime: Number(ct),
      subject: subject!,
    })
  }
  return commits
}

export interface LogPageOptions {
  skip: number
  limit: number
  signal?: AbortSignal
}

/**
 * Load one page of history across all local branches, remote branches, tags
 * and HEAD, in date order (children always before parents).
 */
export async function getCommitPage(repoPath: string, opts: LogPageOptions): Promise<CommitPage> {
  const head = await getHead(repoPath)
  const revs = ['--branches', '--remotes', '--tags']
  if (!head.unborn) revs.push('HEAD')

  // An empty repository (no commits on any ref) has nothing to show.
  const anyRef = await runGit(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], {
    cwd: repoPath,
  })
  if (head.unborn && !anyRef.stdout.trim()) return { commits: [], hasMore: false }

  const { stdout } = await runGit(
    [
      'log',
      '-z',
      '--date-order',
      `--format=${LOG_FORMAT}`,
      `--skip=${opts.skip}`,
      `--max-count=${opts.limit + 1}`,
      ...revs,
      '--',
    ],
    { cwd: repoPath, signal: opts.signal, timeoutMs: 120_000 },
  )
  const commits = parseLog(stdout)
  const hasMore = commits.length > opts.limit
  if (hasMore) commits.length = opts.limit
  return { commits, hasMore }
}

import { GitError } from './errors'
import { getHead } from './refs'
import { runGit } from './runner'

export interface SearchResult {
  /** Matching commit ids, newest first (date order). */
  shas: string[]
  truncated: boolean
}

/**
 * Search the whole history (all branches, remotes, tags and HEAD) for commits
 * whose message, author or committer contains `query` (case-insensitive,
 * literal text), or whose id starts with `query`.
 */
export async function searchCommits(repoPath: string, query: string, opts: { limit?: number } = {}): Promise<SearchResult> {
  const q = query.trim()
  if (!q || q.length > 200 || q.includes('\0')) throw new GitError('INVALID_ARGUMENT', 'Invalid search query')
  const limit = opts.limit ?? 5000

  const head = await getHead(repoPath)
  const revs = ['--branches', '--remotes', '--tags', ...(head.unborn ? [] : ['HEAD'])]
  const base = ['log', '--date-order', '--format=%H', '-F', '-i', `--max-count=${limit + 1}`]
  const run = async (filter: string[]): Promise<string[]> => {
    const { stdout } = await runGit([...base, ...filter, ...revs, '--'], { cwd: repoPath, timeoutMs: 120_000 })
    return stdout.split('\n').filter(Boolean)
  }

  // --grep and --author would be ANDed if combined, so run the filters separately and merge.
  const [byMessage, byAuthor, byCommitter] = await Promise.all([
    run([`--grep=${q}`]),
    run([`--author=${q}`]),
    run([`--committer=${q}`]),
  ])
  const matches = new Set([...byMessage, ...byAuthor, ...byCommitter])

  if (/^[0-9a-f]{4,64}$/i.test(q)) {
    const r = await runGit(['rev-parse', '-q', '--verify', '--end-of-options', `${q}^{commit}`], {
      cwd: repoPath,
      okExitCodes: [0, 1, 128],
    })
    if (r.exitCode === 0) matches.add(r.stdout.trim())
  }
  if (matches.size === 0) return { shas: [], truncated: false }

  // Order all matches consistently with the graph (date order) using one rev walk over just these commits.
  const ordered = await runGit(['rev-list', '--date-order', '--no-walk=sorted', '--stdin'], {
    cwd: repoPath,
    input: [...matches].join('\n') + '\n',
  })
  const shas = ordered.stdout.split('\n').filter(Boolean)
  const truncated = shas.length > limit || byMessage.length > limit || byAuthor.length > limit
  return { shas: shas.slice(0, limit), truncated }
}

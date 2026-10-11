import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runGit } from './runner'

/**
 * Refresh the stat information cached in the index (`git update-index -q --refresh`), so later
 * `git status` calls (which GitBob runs with GIT_OPTIONAL_LOCKS=0 and so never write the index)
 * stop re-hashing files whose timestamps changed. Only metadata is written; file contents and
 * staged changes are untouched. Fails quietly if another Git process holds the index lock.
 */
export async function refreshIndexStat(repoPath: string): Promise<boolean> {
  try {
    const r = await runGit(['update-index', '-q', '--refresh'], { cwd: repoPath, okExitCodes: [0, 1], timeoutMs: 120_000 })
    return r.exitCode === 0 || r.exitCode === 1
  } catch {
    return false
  }
}

/** True if the repository has a commit-graph file (single file or split chain). */
export async function hasCommitGraph(repoPath: string): Promise<boolean> {
  const { stdout } = await runGit(
    ['rev-parse', '--git-path', 'objects/info/commit-graph', '--git-path', 'objects/info/commit-graphs/commit-graph-chain'],
    { cwd: repoPath },
  )
  for (const p of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    try {
      await access(resolve(repoPath, p))
      return true
    } catch {
      /* missing */
    }
  }
  return false
}

/** Write Git's commit-graph for all reachable commits (what `git gc`/`git maintenance` do). */
export async function writeCommitGraph(repoPath: string): Promise<void> {
  await runGit(['commit-graph', 'write', '--reachable'], { cwd: repoPath, timeoutMs: 600_000 })
}

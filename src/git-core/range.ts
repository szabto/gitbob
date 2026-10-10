import type { FileChange } from '@shared/types'
import { parseNameStatus, parseNumstat } from './details'
import { verifyCommit } from './diff'
import { GitError } from './errors'
import { runGit } from './runner'

/** Best common ancestor of two commits (what a pull request diff is based on). */
export async function mergeBase(repoPath: string, a: string, b: string): Promise<string> {
  const [x, y] = await Promise.all([verifyCommit(repoPath, a), verifyCommit(repoPath, b)])
  const r = await runGit(['merge-base', x, y], { cwd: repoPath, okExitCodes: [0, 1] })
  if (r.exitCode !== 0 || !r.stdout.trim()) throw new GitError('NOT_FOUND', 'These commits have no common history')
  return r.stdout.trim()
}

/** Files changed between two commits, with rename detection and line counts. */
export async function getRangeFiles(repoPath: string, base: string, head: string): Promise<FileChange[]> {
  const [b, h] = await Promise.all([verifyCommit(repoPath, base), verifyCommit(repoPath, head)])
  const common = ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--no-ext-diff', b, h]
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

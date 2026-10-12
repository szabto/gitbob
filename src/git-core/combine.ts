import type { CombinedChanges } from '@shared/types'
import { verifyCommit } from './diff'
import { GitError } from './errors'
import { getRangeFiles } from './range'
import { runGit } from './runner'

/** Most commits combined one by one (two git processes each); unbroken stretches have no limit. */
export const MAX_COMBINED_COMMITS = 200

// Fixed identity and date so the helper commits are reproducible and never need user.name/email.
const SYNTHETIC_ENV = {
  GIT_AUTHOR_NAME: 'GitBob',
  GIT_AUTHOR_EMAIL: 'gitbob@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00+0000',
  GIT_COMMITTER_NAME: 'GitBob',
  GIT_COMMITTER_EMAIL: 'gitbob@localhost',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00+0000',
}

/**
 * Writes an unreferenced commit holding `tree`, so diffs can be opened against it. Like any
 * unreachable object, `git gc` removes it later. Refs, the index and the working tree are untouched.
 */
async function syntheticCommit(repoPath: string, tree: string, parent?: string): Promise<string> {
  const args = ['commit-tree', '--no-gpg-sign', tree, ...(parent ? ['-p', parent] : []), '-m', 'GitBob: combined changes']
  return (await runGit(args, { cwd: repoPath, env: SYNTHETIC_ENV })).stdout.trim()
}

/** A commit with an empty tree: the "parent" of a root commit. */
async function emptyCommit(repoPath: string): Promise<string> {
  const tree = (await runGit(['mktree'], { cwd: repoPath, input: '' })).stdout.trim()
  return syntheticCommit(repoPath, tree)
}

/**
 * The changes of several commits taken together. `shas` are in graph order (newer before older,
 * children before parents). An unbroken stretch of history is simply oldest^..newest. Otherwise
 * each commit's own changes (against its first parent) are merged in, oldest first, onto the
 * oldest one's parent, the way cherry-pick would, leaving out the commits in between.
 * `wholeRange` instead diffs the oldest one's parent with the newest, including everything between.
 */
export async function combineCommits(repoPath: string, shas: readonly string[], opts: { wholeRange?: boolean } = {}): Promise<CombinedChanges> {
  const commits = [...new Set(await Promise.all(shas.map((s) => verifyCommit(repoPath, s))))]
  if (commits.length === 0) throw new GitError('INVALID_ARGUMENT', 'No commits selected')
  const newest = commits[0]!
  const oldestFirst = [...commits].reverse()

  // "<sha> <parent> <parent>..." for each commit.
  const parentLines = (await runGit(['rev-list', '--no-walk=unsorted', '--parents', ...commits], { cwd: repoPath })).stdout.trim().split('\n')
  const firstParent = new Map(parentLines.map((l) => l.split(' ')).map(([sha, parent]) => [sha!, parent ?? null]))
  const oldestParent = firstParent.get(oldestFirst[0]!) ?? null
  let empty: string | null = null
  const getEmpty = async (): Promise<string> => (empty ??= await emptyCommit(repoPath))
  const base = oldestParent ?? (await getEmpty())

  const result = async (head: string, mode: CombinedChanges['mode']): Promise<CombinedChanges> => ({ base, head, mode, files: await getRangeFiles(repoPath, base, head) })

  if (opts.wholeRange) return result(newest, 'range')

  // Unbroken stretch: oldest^..newest contains exactly the selected commits.
  const range = await runGit(['rev-list', `--max-count=${commits.length + 1}`, newest, ...(oldestParent ? ['--not', oldestParent] : [])], { cwd: repoPath })
  const inRange = range.stdout.split('\n').filter(Boolean)
  const selected = new Set(commits)
  if (inRange.length === commits.length && inRange.every((c) => selected.has(c))) {
    return result(newest, 'contiguous')
  }

  if (commits.length > MAX_COMBINED_COMMITS) {
    throw new GitError('INVALID_ARGUMENT', `Combining more than ${MAX_COMBINED_COMMITS} separate commits isn't supported; select an unbroken range instead`)
  }

  let acc = base
  for (const commit of oldestFirst) {
    const parent = firstParent.get(commit) ?? (await getEmpty())
    const merged = await runGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${parent}`, acc, commit], { cwd: repoPath, okExitCodes: [0, 1, 128, 129] })
    if (merged.exitCode === 1) {
      // First line: tree id; then the conflicted paths.
      const files = merged.stdout.split('\n').slice(1).filter(Boolean)
      throw new GitError('GIT_FAILED', `Commit ${commit.slice(0, 7)} can't be combined without the commits left out between the selected ones`, {
        detail: files.length ? `Conflicting files:\n${[...new Set(files)].slice(0, 20).join('\n')}` : merged.stderr.trim(),
      })
    }
    if (merged.exitCode !== 0) {
      const old = /unknown option|usage: git merge-tree/i.test(merged.stderr)
      throw new GitError('GIT_FAILED', old ? 'Combining separate commits needs Git 2.40 or newer' : 'Could not combine the selected commits', { detail: merged.stderr.trim() })
    }
    acc = await syntheticCommit(repoPath, merged.stdout.split('\n')[0]!.trim())
  }
  return result(await syntheticCommit(repoPath, `${acc}^{tree}`, base), 'combined')
}

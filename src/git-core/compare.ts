import type { FileChange } from '@shared/types'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNameStatus, parseNumstat } from './details'
import { verifyCommit } from './diff'
import { LITERAL_PATHSPECS_ENV } from './paths'
import { runGit } from './runner'

/** Files that differ between a commit and the working tree (tracked files, renames detected). */
export async function getWorktreeCompareFiles(repoPath: string, sha: string): Promise<FileChange[]> {
  const commit = await verifyCommit(repoPath, sha)
  const common = ['diff', '-z', '-M', '--no-ext-diff', commit]
  const [ns, num] = await Promise.all([
    runGit([...common, '--name-status', '--'], { cwd: repoPath, env: { GIT_OPTIONAL_LOCKS: '0' } }),
    runGit([...common, '--numstat', '--'], { cwd: repoPath, env: { GIT_OPTIONAL_LOCKS: '0' } }),
  ])
  const stats = parseNumstat(num.stdout)
  return parseNameStatus(ns.stdout).map((f) => ({ ...f, additions: stats.get(f.path)?.additions ?? null, deletions: stats.get(f.path)?.deletions ?? null }))
}

/** Write a commit as a mailbox patch (`git format-patch -1`) to `dest`; git writes the bytes itself. */
export async function saveCommitPatch(repoPath: string, sha: string, dest: string): Promise<void> {
  const commit = await verifyCommit(repoPath, sha)
  const dir = await mkdtemp(join(tmpdir(), 'gitbob-patch-'))
  try {
    await runGit(['format-patch', '-1', '--binary', '-o', dir, commit], { cwd: repoPath, env: LITERAL_PATHSPECS_ENV })
    const [file] = await readdir(dir)
    if (!file) throw new Error('git format-patch produced no file')
    await rename(join(dir, file), dest).catch(async () => {
      // Different filesystem: copy then remove.
      const { copyFile } = await import('node:fs/promises')
      await copyFile(join(dir, file), dest)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

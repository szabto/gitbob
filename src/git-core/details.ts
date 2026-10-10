import type { CommitDetails, FileChange, FileChangeStatus } from '@shared/types'
import { GitError } from './errors'
import { runGit } from './runner'

const SHA_RE = /^[0-9a-f]{4,64}$/i
const DETAIL_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s', '%b'].join('%x00')

/** Parse `diff-tree -z --name-status` output. */
export function parseNameStatus(stdout: string): { status: FileChangeStatus; path: string; oldPath?: string }[] {
  const tokens = stdout.split('\0')
  const out: { status: FileChangeStatus; path: string; oldPath?: string }[] = []
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i++]
    if (!code) continue
    const status = code[0] as FileChangeStatus
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i++] ?? ''
      const path = tokens[i++] ?? ''
      out.push({ status, path, oldPath })
    } else {
      out.push({ status, path: tokens[i++] ?? '' })
    }
  }
  return out
}

/** Parse `diff-tree -z --numstat` output into a map keyed by (new) path. */
export function parseNumstat(stdout: string): Map<string, { additions: number | null; deletions: number | null }> {
  const tokens = stdout.split('\0')
  const map = new Map<string, { additions: number | null; deletions: number | null }>()
  let i = 0
  while (i < tokens.length) {
    const head = tokens[i++]
    if (!head) continue
    // Only the first two tabs are separators; the path itself may contain tabs.
    const [a = '', d = '', ...rest] = head.split('\t')
    const path = rest.join('\t')
    const stats = { additions: a === '-' ? null : Number(a), deletions: d === '-' ? null : Number(d) }
    if (path === '') {
      // Rename/copy: "a\td\t" followed by old and new path tokens.
      i++ // old path
      const newPath = tokens[i++] ?? ''
      map.set(newPath, stats)
    } else {
      map.set(path, stats)
    }
  }
  return map
}

export async function getCommitDetails(repoPath: string, sha: string): Promise<CommitDetails> {
  if (!SHA_RE.test(sha)) throw new GitError('INVALID_ARGUMENT', 'Invalid commit id')

  const meta = await runGit(['show', '-s', '-z', `--format=${DETAIL_FORMAT}`, `${sha}^{commit}`, '--'], {
    cwd: repoPath,
  }).catch((e: unknown) => {
    if (e instanceof GitError && e.code === 'GIT_FAILED') throw new GitError('NOT_FOUND', `Commit ${sha} not found`)
    throw e
  })
  const [fullSha = '', parents = '', an = '', ae = '', at = '0', cn = '', ce = '', ct = '0', subject = '', body = ''] =
    meta.stdout.split('\0')
  const parentList = parents ? parents.split(' ') : []

  // Compare against the first parent (merges included); root commits compare against the empty tree.
  const range = parentList[0] ? [parentList[0], fullSha] : ['--root', fullSha]
  const common = ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--no-ext-diff', ...range, '--']
  const [ns, num] = await Promise.all([
    runGit([...common.slice(0, -1), '--name-status', '--'], { cwd: repoPath }),
    runGit([...common.slice(0, -1), '--numstat', '--'], { cwd: repoPath }),
  ])
  const stats = parseNumstat(num.stdout)
  const files: FileChange[] = parseNameStatus(ns.stdout).map((f) => ({
    ...f,
    additions: stats.get(f.path)?.additions ?? null,
    deletions: stats.get(f.path)?.deletions ?? null,
  }))

  return {
    sha: fullSha,
    parents: parentList,
    authorName: an,
    authorEmail: ae,
    authorTime: Number(at),
    committerName: cn,
    committerEmail: ce,
    commitTime: Number(ct),
    subject,
    body: body.replace(/\s+$/, ''),
    files,
  }
}

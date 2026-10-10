import { lstat, open, readlink } from 'node:fs/promises'
import { GitError } from './errors'
import { resolveRepoPath } from './paths'
import { runGit } from './runner'
import type { BlameLine } from '@shared/types'
export type { BlameLine }


export interface BlameResult {
  lines: BlameLine[]
  /** File content, one entry per line (without line terminator). */
  text: string[]
}

export const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000'
export const MAX_BLAME_LINES = 50_000
const MAX_BLAME_BYTES = 16 * 1024 * 1024
const SHA_RE = /^[0-9a-f]{4,64}$/i
const BLAME_TIMEOUT = 120_000
const BINARY_PROBE = 8000

interface CommitInfo {
  authorName: string
  authorTime: number
  summary: string
  boundary: boolean
}

/** Parse `git blame --porcelain`. Commit headers appear only on the first occurrence of a sha. */
export function parseBlamePorcelain(stdout: string): BlameResult {
  const commits = new Map<string, CommitInfo>()
  const lines: BlameLine[] = []
  const text: string[] = []
  const rows = stdout.split('\n')
  let current: { sha: string; originalLine: number; line: number } | null = null
  for (const row of rows) {
    if (current === null) {
      const m = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(row)
      if (!m) continue
      const sha = m[1]!
      current = { sha, originalLine: Number(m[2]), line: Number(m[3]) }
      if (!commits.has(sha)) commits.set(sha, { authorName: '', authorTime: 0, summary: '', boundary: false })
      continue
    }
    if (row.startsWith('\t')) {
      const info = commits.get(current.sha)!
      lines.push({ ...current, ...info })
      text.push(row.slice(1).replace(/\r$/, ''))
      current = null
      continue
    }
    const info = commits.get(current.sha)!
    const sp = row.indexOf(' ')
    const key = sp === -1 ? row : row.slice(0, sp)
    const value = sp === -1 ? '' : row.slice(sp + 1)
    if (key === 'author') info.authorName = value
    else if (key === 'author-time') info.authorTime = Number(value) || 0
    else if (key === 'summary') info.summary = value
    else if (key === 'boundary') info.boundary = true
  }
  return { lines, text }
}

function tooLarge(): GitError {
  return new GitError('INVALID_ARGUMENT', `File is too large to blame (limit ${MAX_BLAME_LINES} lines)`)
}

function checkContent(content: Buffer): void {
  if (content.length > MAX_BLAME_BYTES) throw tooLarge()
  if (content.subarray(0, BINARY_PROBE).includes(0)) throw new GitError('INVALID_ARGUMENT', 'Cannot blame a binary file')
  let n = 0
  for (let i = content.indexOf(10); i !== -1; i = content.indexOf(10, i + 1)) {
    if (++n > MAX_BLAME_LINES) throw tooLarge()
  }
}

async function readWorkingFile(abs: string): Promise<Buffer | null> {
  let st
  try {
    st = await lstat(abs)
  } catch {
    return null // deleted or untracked: let git report it
  }
  // Never follow symlinks out of the repository; git blames the link text.
  if (st.isSymbolicLink()) return Buffer.from(await readlink(abs))
  if (!st.isFile()) throw new GitError('INVALID_ARGUMENT', 'Not a file')
  if (st.size > MAX_BLAME_BYTES) throw tooLarge()
  const fh = await open(abs, 'r')
  try {
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

function notFound(path: string, rev?: string): GitError {
  return new GitError('NOT_FOUND', rev ? `${path} does not exist in ${rev.slice(0, 7)}` : `${path} is not tracked`)
}

/**
 * Line-by-line attribution of `path` (repository-relative). Without `rev` the working tree version
 * is blamed, so uncommitted lines get the all-zero sha and author "Not Committed Yet".
 */
export async function getBlame(repoPath: string, path: string, rev?: string): Promise<BlameResult> {
  const abs = resolveRepoPath(repoPath, path)
  let commit: string | undefined
  if (rev !== undefined) {
    if (typeof rev !== 'string' || !SHA_RE.test(rev)) throw new GitError('INVALID_ARGUMENT', 'Invalid commit id')
    const r = await runGit(['rev-parse', '-q', '--verify', `${rev}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1, 128] })
    if (r.exitCode !== 0) throw new GitError('NOT_FOUND', `Commit ${rev} not found`)
    commit = r.stdout.trim()
    const spec = `${commit}:${path}`
    const type = await runGit(['cat-file', '-t', spec], { cwd: repoPath, okExitCodes: [0, 1, 128] })
    if (type.exitCode !== 0) throw notFound(path, commit)
    if (type.stdout.trim() !== 'blob') throw new GitError('INVALID_ARGUMENT', 'Not a file')
    const size = Number((await runGit(['cat-file', '-s', spec], { cwd: repoPath })).stdout.trim())
    if (size > MAX_BLAME_BYTES) throw tooLarge()
    const blob = await runGit(['cat-file', 'blob', spec], { cwd: repoPath })
    checkContent(Buffer.from(blob.stdout, 'utf8'))
  } else {
    const content = await readWorkingFile(abs)
    if (content) checkContent(content)
  }

  const args = ['blame', '--porcelain', ...(commit ? [commit] : []), '--', path]
  const r = await runGit(args, { cwd: repoPath, timeoutMs: BLAME_TIMEOUT, okExitCodes: [0, 128] })
  if (r.exitCode !== 0) {
    if (/no such path|no such ref|does not exist/i.test(r.stderr)) throw notFound(path, commit)
    throw new GitError('GIT_FAILED', r.stderr.split('\n')[0]?.replace(/^fatal: /, '') || 'git blame failed', {
      detail: r.stderr,
      exitCode: r.exitCode,
    })
  }
  const result = parseBlamePorcelain(r.stdout)
  if (result.lines.length > MAX_BLAME_LINES) throw tooLarge()
  return result
}

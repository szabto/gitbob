import type { CommitSummary, FileHistoryEntry, FileHistoryPage } from '@shared/types'
import { GitError } from './errors'
import { LOG_FORMAT, parseLog } from './log'
import { LITERAL_PATHSPECS_ENV, resolveRepoPath } from './paths'
import { runGit } from './runner'

const FIELD_COUNT = LOG_FORMAT.split('%x00').length
const STATUS_RE = /^[ACDMRTUX]\d*$/

/**
 * Parse `git log -z --format=%x01<LOG_FORMAT> --name-status` output. Each record is
 * `\x01` + NUL-separated fields + `\0\n` + (status NUL path NUL [new-path NUL]) — the file part is
 * missing for commits git lists without a change to the path (e.g. some merges).
 * Parsed sequentially so subjects can never be mistaken for structure.
 */
export function parseFileHistory(stdout: string): FileHistoryEntry[] {
  const out: FileHistoryEntry[] = []
  let i = 0
  const readToken = (): string => {
    const end = stdout.indexOf('\0', i)
    if (end === -1) throw new Error('Malformed git log output')
    const t = stdout.slice(i, end)
    i = end + 1
    return t
  }
  while (i < stdout.length) {
    if (stdout[i] === '\n') {
      i++
      continue
    }
    if (stdout[i] !== '\x01') throw new Error('Malformed git log output')
    i++
    const fields: string[] = []
    for (let f = 0; f < FIELD_COUNT; f++) fields.push(readToken())
    const commit: CommitSummary = parseLog(fields.join('\0'))[0]!
    let status: string | null = null
    let path: string | null = null
    let oldPath: string | undefined
    // Optional "\0\n" (the empty field ending the header) followed by a name-status entry.
    if (stdout[i] === '\0') i++
    if (stdout[i] === '\n') i++
    if (i < stdout.length && stdout[i] !== '\x01') {
      const s = readToken()
      if (!STATUS_RE.test(s)) throw new Error('Malformed git log output')
      status = s[0]!
      const first = readToken()
      if (status === 'R' || status === 'C') {
        oldPath = first
        path = readToken()
      } else {
        path = first
      }
    }
    out.push({ commit, status: (status ?? 'M') as FileHistoryEntry['status'], path: path ?? '', ...(oldPath !== undefined ? { oldPath } : {}) })
  }
  // Fill paths for entries git printed without a file part from the next (older) known name.
  let known = ''
  for (let k = out.length - 1; k >= 0; k--) {
    if (out[k]!.path) known = out[k]!.path
    else out[k]!.path = known
  }
  return out
}

/**
 * Commits that changed `path`, newest first, following renames (`git log --follow`).
 * Each entry carries the file's name in that commit so its diff can be shown.
 */
export async function getFileHistory(
  repoPath: string,
  path: string,
  opts: { skip?: number; limit?: number } = {},
): Promise<FileHistoryPage> {
  resolveRepoPath(repoPath, path)
  if (!path || path.endsWith('/')) throw new GitError('INVALID_ARGUMENT', 'File history needs a file path')
  const skip = opts.skip ?? 0
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000)
  if (!Number.isInteger(skip) || skip < 0) throw new GitError('INVALID_ARGUMENT', 'Invalid skip')
  const head = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1, 128] })
  if (head.exitCode !== 0) return { entries: [], hasMore: false }
  const { stdout } = await runGit(
    [
      'log',
      '-z',
      '--follow',
      '-M',
      '--name-status',
      `--format=%x01${LOG_FORMAT}`,
      `--skip=${skip}`,
      `--max-count=${limit + 1}`,
      'HEAD',
      '--',
      path,
    ],
    { cwd: repoPath, env: LITERAL_PATHSPECS_ENV, timeoutMs: 120_000 },
  )
  const entries = parseFileHistory(stdout)
  return { entries: entries.slice(0, limit), hasMore: entries.length > limit }
}

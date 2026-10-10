import type { DiffHunk, DiffLine, DiffTarget, FileDiff } from '@shared/types'
import { GitError } from './errors'
import { resolveRepoPath } from './paths'
import { runGit } from './runner'

const SHA_RE = /^[0-9a-f]{4,64}$/i
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/**
 * A diff target that may name the old path of a staged rename (`{ kind: 'staged', path, oldPath }`),
 * so the diff shows the rename and its content change instead of an added file.
 */
export type DiffTargetInput = DiffTarget | { kind: 'staged'; path: string; oldPath?: string }

/** `oldPath` of a staged rename target, if given and different from `path` (validated). */
export function stagedOldPath(repoPath: string, target: DiffTargetInput): string | undefined {
  if (target.kind !== 'staged') return undefined
  const oldPath = (target as { oldPath?: unknown }).oldPath
  if (oldPath === undefined) return undefined
  if (typeof oldPath !== 'string') throw new GitError('INVALID_ARGUMENT', 'Invalid path')
  resolveRepoPath(repoPath, oldPath)
  return oldPath === target.path ? undefined : oldPath
}

export type ParsedFileDiff = Omit<FileDiff, 'path' | 'truncated'> & { path?: string }

/**
 * Options that make `git diff` output independent of user configuration
 * (external diff drivers, textconv, mnemonic/no prefixes, diff.relative, submodule format).
 */
const DIFF_OPTS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--submodule=short',
]

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/** Undo Git's C-style quoting of a path (`"a\tb\303\251"`). Unquoted input is returned unchanged. */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s
  const bytes: number[] = []
  const body = s.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = body[i + 1] ?? ''
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0]
      bytes.push(parseInt(oct, 8))
      i += oct.length
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]!)
      i++
    } else {
      bytes.push(92)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Path from a `--- a/x` / `+++ b/x` line; null for /dev/null. */
function headerPath(rest: string): string | null {
  const p = unquoteGitPath(rest.replace(/\t$/, ''))
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse `git diff` output (possibly several files) into per-file diffs.
 * Hunk line counts from the `@@` header decide where a hunk ends, so content
 * lines that look like headers are never misread.
 */
export function parseUnifiedDiffFiles(text: string): ParsedFileDiff[] {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const files: ParsedFileDiff[] = []
  let cur: ParsedFileDiff | null = null
  let i = 0

  const start = (): ParsedFileDiff => {
    const f: ParsedFileDiff = { binary: false, isNew: false, isDeleted: false, hunks: [] }
    files.push(f)
    return f
  }

  while (i < lines.length) {
    const line = lines[i++]!
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      cur = start()
      continue
    }
    cur ??= start()

    const hm = HUNK_RE.exec(line)
    if (hm) {
      const hunk: DiffHunk = {
        header: line,
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        lines: [],
      }
      cur.hunks.push(hunk)
      let oldLeft = hunk.oldLines
      let newLeft = hunk.newLines
      let oldNo = hunk.oldStart
      let newNo = hunk.newStart
      while (i < lines.length) {
        const l = lines[i]!
        if (l.startsWith('\\')) {
          hunk.lines.push({ type: 'no-newline', content: l.slice(1).trim(), oldLine: null, newLine: null })
          i++
          continue
        }
        if (oldLeft <= 0 && newLeft <= 0) break
        const c = l[0]
        let dl: DiffLine
        if (c === '+') {
          dl = { type: 'add', content: l.slice(1), oldLine: null, newLine: newNo++ }
          newLeft--
        } else if (c === '-') {
          dl = { type: 'del', content: l.slice(1), oldLine: oldNo++, newLine: null }
          oldLeft--
        } else if (c === ' ' || l === '') {
          // An empty line is a context line whose leading space was stripped.
          dl = { type: 'context', content: l.slice(1), oldLine: oldNo++, newLine: newNo++ }
          oldLeft--
          newLeft--
        } else {
          break // malformed/truncated hunk
        }
        hunk.lines.push(dl)
        i++
      }
      continue
    }

    if (cur.hunks.length) continue // trailing garbage after hunks; ignore
    if (line.startsWith('new file mode')) cur.isNew = true
    else if (line.startsWith('deleted file mode')) cur.isDeleted = true
    else if (line.startsWith('rename from ')) cur.oldPath = unquoteGitPath(line.slice('rename from '.length))
    else if (line.startsWith('rename to ')) cur.path = unquoteGitPath(line.slice('rename to '.length))
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') cur.binary = true
    else if (line.startsWith('--- ')) {
      const p = headerPath(line.slice(4))
      if (p === null) cur.isNew = true
      else if (cur.oldPath === undefined && !cur.path) cur.oldPath = p
    } else if (line.startsWith('+++ ')) {
      const p = headerPath(line.slice(4))
      if (p === null) cur.isDeleted = true
      else cur.path = p
    }
  }

  // `oldPath` is only meaningful for renames/copies.
  for (const f of files) {
    if (f.oldPath !== undefined && (f.oldPath === f.path || f.isNew || f.isDeleted)) {
      if (f.isDeleted && f.path === undefined) f.path = f.oldPath
      delete f.oldPath
    }
  }
  return files
}

/** Parse a single file's `git diff` output. */
export function parseUnifiedDiff(text: string): ParsedFileDiff {
  return parseUnifiedDiffFiles(text)[0] ?? { binary: false, isNew: false, isDeleted: false, hunks: [] }
}

async function resolveCommit(repoPath: string, sha: string): Promise<{ sha: string; parent: string | null }> {
  if (!SHA_RE.test(sha)) throw new GitError('INVALID_ARGUMENT', 'Invalid commit id')
  const r = await runGit(['show', '-s', '-z', '--format=%H%x00%P', `${sha}^{commit}`, '--'], {
    cwd: repoPath,
  }).catch((e: unknown) => {
    if (e instanceof GitError && e.code === 'GIT_FAILED') throw new GitError('NOT_FOUND', `Commit ${sha} not found`)
    throw e
  })
  const [full = '', parents = ''] = r.stdout.split('\0')
  return { sha: full, parent: parents.split(' ').filter(Boolean)[0] ?? null }
}

/**
 * Diff of one file. `unstaged` = index vs worktree, `staged` = HEAD (or empty tree) vs index
 * (with `oldPath`: the staged rename `oldPath` -> `path`, reported with `oldPath` and the hunks of
 * any content change),
 * `untracked` = whole file as added, `commit` = commit vs its first parent (root: vs empty tree).
 * Output larger than `maxBytes` is cut and returned with `truncated: true`.
 */
export async function getFileDiff(
  repoPath: string,
  target: DiffTargetInput,
  opts: { maxBytes?: number } = {},
): Promise<FileDiff> {
  resolveRepoPath(repoPath, target.path)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  let args: string[]
  let okExitCodes = [0]

  switch (target.kind) {
    case 'unstaged':
      args = ['diff', ...DIFF_OPTS, '--no-relative', '-M', '--', target.path]
      break
    case 'staged': {
      // `--cached` without a commit compares against the empty tree on an unborn branch.
      // Both paths in the pathspec let rename detection pair the deletion with the addition.
      const oldPath = stagedOldPath(repoPath, target)
      args = ['diff', '--cached', ...DIFF_OPTS, '--no-relative', '-M', '--', target.path, ...(oldPath ? [oldPath] : [])]
      break
    }
    case 'untracked':
      // Git handles `/dev/null` itself for --no-index on every platform (including Windows).
      args = ['diff', '--no-index', ...DIFF_OPTS, '--', '/dev/null', target.path]
      okExitCodes = [0, 1]
      break
    case 'commit': {
      if (target.oldPath !== undefined) resolveRepoPath(repoPath, target.oldPath)
      const { sha, parent } = await resolveCommit(repoPath, target.sha)
      const paths = target.oldPath && target.oldPath !== target.path ? [target.path, target.oldPath] : [target.path]
      args = [
        'diff-tree',
        '-p',
        '-r',
        '-M',
        '--no-commit-id',
        ...DIFF_OPTS,
        ...(parent ? [parent, sha] : ['--root', sha]),
        '--',
        ...paths,
      ]
      break
    }
    case 'range': {
      if (target.oldPath !== undefined) resolveRepoPath(repoPath, target.oldPath)
      const [base, head] = await Promise.all([verifyCommit(repoPath, target.base), verifyCommit(repoPath, target.head)])
      const paths = target.oldPath && target.oldPath !== target.path ? [target.path, target.oldPath] : [target.path]
      args = ['diff-tree', '-p', '-r', '-M', '--no-commit-id', ...DIFF_OPTS, base, head, '--', ...paths]
      break
    }
  }

  const r = await runGit(args, {
    cwd: repoPath,
    okExitCodes,
    maxOutputBytes: maxBytes,
    truncateOutput: true,
    env: { GIT_LITERAL_PATHSPECS: '1' },
  })
  let text = r.stdout
  // Drop a partially received last line so it is not mistaken for content.
  if (r.truncated) text = text.slice(0, text.lastIndexOf('\n') + 1)

  const files = parseUnifiedDiffFiles(text)
  const parsed =
    files.find((f) => f.path === target.path) ??
    files[0] ?? { binary: false, isNew: false, isDeleted: false, hunks: [] }
  const result: FileDiff = {
    path: target.path,
    binary: parsed.binary,
    isNew: parsed.isNew,
    isDeleted: parsed.isDeleted,
    hunks: parsed.hunks,
    truncated: r.truncated === true,
  }
  if (parsed.oldPath !== undefined) result.oldPath = parsed.oldPath
  return result
}

/** Full sha of a commit given as a validated hex id; NOT_FOUND if it isn't in the repository. */
export async function verifyCommit(repoPath: string, rev: string): Promise<string> {
  if (!/^[0-9a-f]{4,64}$/i.test(rev)) throw new GitError('INVALID_ARGUMENT', 'Invalid commit id')
  const r = await runGit(['rev-parse', '-q', '--verify', `${rev}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1, 128] })
  if (r.exitCode !== 0) throw new GitError('NOT_FOUND', `Commit ${rev} is not in this repository`)
  return r.stdout.trim()
}

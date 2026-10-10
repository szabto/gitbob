import type { DiffHunk, DiffLine } from '@shared/types'
import { getFileDiff } from './diff'
import { GitError } from './errors'
import { LITERAL_PATHSPECS_ENV, resolveRepoPath } from './paths'
import { runGit } from './runner'
import type { HunkSelection } from '@shared/types'
export type { HunkSelection }


export interface BuildPatchOptions {
  /**
   * The patch will be applied with `git apply --reverse` (unstage, discard). Unselected
   * lines then have to describe the current target (the diff's new side) rather than
   * its old side: unselected `+` lines become context and unselected `-` lines are dropped.
   */
  reverse?: boolean
}

const STALE_MESSAGE = 'The file changed; refresh and try again'
const NO_NEWLINE = '\\ No newline at end of file'
const INDEX_TIMEOUT = 120_000

interface OutLine {
  type: 'context' | 'add' | 'del'
  content: string
  /** A "\ No newline at end of file" marker follows this line. */
  noEol: boolean
}

/** Quote a path the way Git's C-style quoting does; plain safe names are left as is. */
export function quoteGitPath(p: string): string {
  if (/^[A-Za-z0-9._\-/+@,=~%]+$/.test(p)) return p
  let out = '"'
  for (const byte of Buffer.from(p, 'utf8')) {
    if (byte === 0x22) out += '\\"'
    else if (byte === 0x5c) out += '\\\\'
    else if (byte === 0x09) out += '\\t'
    else if (byte === 0x0a) out += '\\n'
    else if (byte === 0x0d) out += '\\r'
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte)
    else out += '\\' + byte.toString(8).padStart(3, '0')
  }
  return out + '"'
}

function invalid(message: string): GitError {
  return new GitError('INVALID_ARGUMENT', message)
}

interface Picked {
  type: 'context' | 'add' | 'del'
  content: string
  /** Type of the line in the original hunk. */
  orig: 'context' | 'add' | 'del'
  /** The original line was followed by a "\ No newline at end of file" marker. */
  origNoEol: boolean
  /** Position among the removed (or added) lines of its change block in the original hunk. */
  pair: number
}

/**
 * Lines of one hunk after applying a selection; null if no change survives.
 *
 * Forward (apply to the diff's old side): unselected `+` lines are dropped and
 * unselected `-` lines become context. Reverse (`git apply --reverse`, the target is
 * the new side): unselected `-` lines are dropped and unselected `+` lines become context.
 */
function selectLines(hunk: DiffHunk, chosen: Set<number> | null, reverse: boolean): OutLine[] | null {
  const picked: Picked[] = []
  const src = hunk.lines
  let delNo = 0
  let addNo = 0
  for (let i = 0; i < src.length; i++) {
    const line: DiffLine = src[i]!
    if (line.type === 'no-newline') continue
    if (line.type === 'context') delNo = addNo = 0
    const pair = line.type === 'del' ? delNo++ : line.type === 'add' ? addNo++ : 0
    const base = { content: line.content, origNoEol: src[i + 1]?.type === 'no-newline', pair }
    const selected = chosen === null || chosen.has(i)
    if (line.type === 'context') picked.push({ ...base, type: 'context', orig: 'context' })
    else if (selected) picked.push({ ...base, type: line.type, orig: line.type })
    else if (line.type === 'add' && reverse) picked.push({ ...base, type: 'context', orig: 'add' })
    else if (line.type === 'del' && !reverse) picked.push({ ...base, type: 'context', orig: 'del' })
  }
  if (!picked.some((l) => l.type !== 'context')) return null

  // Within each change block, a line turned into context must sit between the additions
  // the way the original lines paired up (k-th removed line <-> k-th added line); otherwise
  // "-b -c +B" with only "-b"/"+B" selected would yield "c B" instead of "B c".
  const ordered: Picked[] = []
  for (let i = 0; i < picked.length; ) {
    if (picked[i]!.orig === 'context') {
      ordered.push(picked[i++]!)
      continue
    }
    const block: Picked[] = []
    while (i < picked.length && picked[i]!.orig !== 'context') block.push(picked[i++]!)
    if (!block.some((l) => l.type === 'context')) {
      ordered.push(...block)
      continue
    }
    // Stable sort by pair position, removed line before its added counterpart.
    const rank = (l: Picked): number => l.pair * 2 + (l.orig === 'add' ? 1 : 0)
    ordered.push(...[...block].sort((x, y) => rank(x) - rank(y)))
  }

  // A line may lack its trailing newline only if it is the last line on that side. Lines
  // that no longer end a side get one; a context line whose newline then differs between
  // the sides is written as a removal plus an addition.
  let lastOld = -1
  let lastNew = -1
  ordered.forEach((l, i) => {
    if (l.type !== 'add') lastOld = i
    if (l.type !== 'del') lastNew = i
  })
  const result: OutLine[] = []
  ordered.forEach((l, i) => {
    const oldNoEol = l.origNoEol && i === lastOld
    const newNoEol = l.origNoEol && i === lastNew
    if (l.type === 'del') result.push({ type: 'del', content: l.content, noEol: oldNoEol })
    else if (l.type === 'add') result.push({ type: 'add', content: l.content, noEol: newNoEol })
    else if (oldNoEol === newNoEol) result.push({ type: 'context', content: l.content, noEol: oldNoEol })
    else {
      result.push({ type: 'del', content: l.content, noEol: oldNoEol }, { type: 'add', content: l.content, noEol: newNoEol })
    }
  })
  return result
}

/**
 * Build a unified diff for `path` containing only the selected hunks (or lines of hunks).
 * Without `reverse`: unselected `+` lines are dropped, unselected `-` lines become context.
 * With `reverse` (for `git apply --reverse`) the roles swap. Headers are recomputed so the
 * patch is exact. Throws INVALID_ARGUMENT for out-of-range or stale selections.
 */
export function buildPatch(
  path: string,
  hunks: DiffHunk[],
  selections: HunkSelection[],
  opts: BuildPatchOptions = {},
): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw invalid('Invalid path')
  if (!Array.isArray(selections)) throw invalid('Invalid selection')
  const reverse = opts.reverse === true
  const seen = new Set<number>()
  for (const sel of selections) {
    if (!Number.isInteger(sel.hunkIndex) || sel.hunkIndex < 0) throw invalid('Invalid hunk index')
    if (seen.has(sel.hunkIndex)) throw invalid('Duplicate hunk selection')
    seen.add(sel.hunkIndex)
    const hunk = hunks[sel.hunkIndex]
    if (!hunk || hunk.header !== sel.header) throw invalid(STALE_MESSAGE)
    if (sel.lines !== undefined) {
      if (!Array.isArray(sel.lines)) throw invalid('Invalid line selection')
      for (const n of sel.lines) {
        if (!Number.isInteger(n) || n < 0 || n >= hunk.lines.length) throw invalid('Invalid line index')
      }
    }
  }

  const ordered = [...selections].sort((a, b) => a.hunkIndex - b.hunkIndex)
  const body: string[] = []
  let delta = 0 // cumulative (new - old) line count of the hunks emitted so far
  for (const sel of ordered) {
    const hunk = hunks[sel.hunkIndex]!
    const lines = selectLines(hunk, sel.lines ? new Set(sel.lines) : null, reverse)
    if (!lines) continue
    const oldCount = lines.filter((l) => l.type !== 'add').length
    const newCount = lines.filter((l) => l.type !== 'del').length

    // The side the patch is applied to keeps its original position; the other side is
    // shifted by the changes emitted before. A side with zero lines names the line before.
    let oldStart: number
    let newStart: number
    if (!reverse) {
      oldStart = hunk.oldStart
      const firstOld = oldCount > 0 ? oldStart : oldStart + 1
      const firstNew = firstOld + delta
      newStart = newCount > 0 ? firstNew : firstNew - 1
    } else {
      newStart = hunk.newStart
      const firstNew = newCount > 0 ? newStart : newStart + 1
      const firstOld = firstNew - delta
      oldStart = oldCount > 0 ? firstOld : firstOld - 1
    }
    delta += newCount - oldCount

    const section = /^@@ [^@]* @@(.*)$/.exec(hunk.header)?.[1] ?? ''
    body.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${section}`)
    for (const l of lines) {
      body.push((l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.content)
      if (l.noEol) body.push(NO_NEWLINE)
    }
  }
  if (body.length === 0) return ''

  const a = quoteGitPath(`a/${path}`)
  const b = quoteGitPath(`b/${path}`)
  return [`diff --git ${a} ${b}`, `--- ${a}`, `+++ ${b}`, ...body].join('\n') + '\n'
}

/** Index entries (mode and stage) of exactly `path`. */
async function indexEntries(repoPath: string, path: string): Promise<{ mode: string; stage: number }[]> {
  const r = await runGit(['ls-files', '-s', '-z', '--', path], { cwd: repoPath, env: LITERAL_PATHSPECS_ENV })
  const entries: { mode: string; stage: number }[] = []
  for (const rec of r.stdout.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab < 0 || rec.slice(tab + 1) !== path) continue
    const [mode = '', , stage = '0'] = rec.slice(0, tab).split(' ')
    entries.push({ mode, stage: Number(stage) })
  }
  return entries
}

/**
 * Stage, unstage or discard selected hunks/lines of one file with `git apply`.
 * - unstaged + stage: `git apply --cached`
 * - staged + unstage: `git apply --cached --reverse`
 * - unstaged + discard: `git apply --reverse` (worktree only; confirm in the UI first)
 * The current diff is re-read and every selection's header must still match, so a stale
 * patch is never applied. Binary, new, deleted, renamed, unmerged files and submodules
 * are refused (whole-file operations handle them).
 */
export async function applyHunks(
  repoPath: string,
  path: string,
  source: 'unstaged' | 'staged',
  action: 'stage' | 'unstage' | 'discard',
  selections: HunkSelection[],
): Promise<void> {
  resolveRepoPath(repoPath, path)
  let applyArgs: string[]
  if (source === 'unstaged' && action === 'stage') applyArgs = ['--cached']
  else if (source === 'staged' && action === 'unstage') applyArgs = ['--cached', '--reverse']
  else if (source === 'unstaged' && action === 'discard') applyArgs = ['--reverse']
  else throw invalid(`Cannot ${String(action)} ${String(source)} changes`)
  const reverse = applyArgs.includes('--reverse')
  if (!Array.isArray(selections) || selections.length === 0) throw invalid('No changes selected')

  const entries = await indexEntries(repoPath, path)
  if (entries.some((e) => e.stage !== 0)) {
    throw invalid(`Line staging is not available for a conflicted file: ${path}`)
  }
  if (entries.some((e) => e.mode === '160000')) {
    throw invalid(`Line staging is not available for a submodule: ${path}`)
  }

  const diff = await getFileDiff(repoPath, { kind: source, path })
  if (diff.binary) throw invalid(`Line staging is not available for a binary file: ${path}`)
  if (diff.isNew) throw invalid(`Line staging is not available for a new file; stage the whole file: ${path}`)
  if (diff.isDeleted) throw invalid(`Line staging is not available for a deleted file: ${path}`)
  if (diff.oldPath !== undefined) throw invalid(`Line staging is not available for a renamed file: ${path}`)
  if (diff.truncated) throw invalid(`The diff of ${path} is too large for line staging`)
  if (diff.hunks.length === 0) throw invalid(STALE_MESSAGE)
  // Diff text is decoded as UTF-8; applying lines with replaced bytes would corrupt the file.
  if (diff.hunks.some((h) => h.lines.some((l) => l.content.includes('�')))) {
    throw invalid(`Line staging is not available for a file that is not valid UTF-8: ${path}`)
  }

  const patch = buildPatch(path, diff.hunks, selections, { reverse })
  if (!patch) throw invalid('No changes selected')

  await runGit(['apply', ...applyArgs, '--whitespace=nowarn', '--recount', '-'], {
    cwd: repoPath,
    input: patch,
    timeoutMs: INDEX_TIMEOUT,
  })
}

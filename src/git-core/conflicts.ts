import { hasConflictMarkers } from '@shared/conflict-markers'
import { readBlob, readWorktreeFile } from './contents'
import { GitError } from './errors'
import { LITERAL_PATHSPECS_ENV, resolveRepoPath } from './paths'
import { runGit } from './runner'
import { writeRepoFile } from './worktree-file'
import type { ConflictVersions } from '@shared/types'
import type { ConflictKind, ConflictDescription } from '@shared/types'
export type { ConflictKind, ConflictDescription }
export type { ConflictVersions }


/** Conflict sides can be large generated files; this is a safety cap, not a UX limit. */
const MAX_CONFLICT_BYTES = 50 * 1024 * 1024
const INDEX_TIMEOUT = 120_000

interface StageEntry {
  mode: string
  id: string
  stage: number
}

/** Unmerged index entries of exactly `path` (empty if the path is not conflicted). */
async function unmergedEntries(repoPath: string, path: string): Promise<StageEntry[]> {
  const r = await runGit(['ls-files', '-u', '-z', '--', path], { cwd: repoPath, env: LITERAL_PATHSPECS_ENV })
  const entries: StageEntry[] = []
  for (const rec of r.stdout.split('\0')) {
    const tab = rec.indexOf('\t')
    // The pathspec also matches files below a directory; keep only the exact path.
    if (tab < 0 || rec.slice(tab + 1) !== path) continue
    const [mode = '', id = '', stage = ''] = rec.slice(0, tab).split(' ')
    const n = Number(stage)
    if (n >= 1 && n <= 3) entries.push({ mode, id, stage: n })
  }
  return entries
}

async function requireUnmerged(repoPath: string, path: string): Promise<StageEntry[]> {
  resolveRepoPath(repoPath, path)
  const entries = await unmergedEntries(repoPath, path)
  if (entries.length === 0) throw new GitError('INVALID_ARGUMENT', `Not a conflicted file: ${path}`)
  return entries
}

async function verifyRev(repoPath: string, rev: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '-q', '--verify', `${rev}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1] })
  return r.exitCode === 0 ? r.stdout.trim() || null : null
}

/** A readable name for a commit: a branch pointing at it, else its short id. */
async function describeCommit(repoPath: string, sha: string): Promise<string> {
  const refs = await runGit(
    ['for-each-ref', '--format=%(refname:short)', `--points-at=${sha}`, 'refs/heads', 'refs/remotes'],
    { cwd: repoPath },
  )
  const name = refs.stdout.split('\n').find((l) => l.trim().length > 0)
  if (name) return name.trim()
  const short = await runGit(['rev-parse', '--short', sha], { cwd: repoPath })
  return short.stdout.trim() || sha.slice(0, 7)
}

/** Labels for the two sides: current branch and the commit being merged/picked/reverted. */
async function conflictLabels(repoPath: string): Promise<{ oursLabel: string; theirsLabel: string }> {
  let oursLabel = 'ours'
  let theirsLabel = 'theirs'
  try {
    const head = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: repoPath, okExitCodes: [0, 1] })
    if (head.exitCode === 0 && head.stdout.trim()) oursLabel = head.stdout.trim()
    for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
      const sha = await verifyRev(repoPath, ref)
      if (sha) {
        theirsLabel = await describeCommit(repoPath, sha)
        break
      }
    }
  } catch {
    // Labels are cosmetic; never fail the conflict view over them.
  }
  return { oursLabel, theirsLabel }
}

/**
 * Base/ours/theirs from index stages 1-3 and the current worktree content of a
 * conflicted file. INVALID_ARGUMENT if `path` is not currently unmerged.
 */
export async function getConflictVersions(repoPath: string, path: string): Promise<ConflictVersions> {
  const entries = await requireUnmerged(repoPath, path)
  const blobFor = async (stage: number): Promise<{ text: string | null; binary: boolean }> => {
    const e = entries.find((x) => x.stage === stage)
    if (!e) return { text: null, binary: false }
    if (e.mode === '160000') return { text: null, binary: true } // submodule: not text
    const side = await readBlob(repoPath, { id: e.id, size: 0 }, MAX_CONFLICT_BYTES)
    if (side.tooLarge) throw new GitError('INVALID_ARGUMENT', `The conflicted file is too large to merge here: ${path}`)
    return side
  }
  const [base, ours, theirs, worktree, labels] = await Promise.all([
    blobFor(1),
    blobFor(2),
    blobFor(3),
    readWorktreeFile(repoPath, path, MAX_CONFLICT_BYTES),
    conflictLabels(repoPath),
  ])
  if (worktree.tooLarge) throw new GitError('INVALID_ARGUMENT', `The conflicted file is too large to merge here: ${path}`)

  const binary = base.binary || ours.binary || theirs.binary || worktree.binary
  if (binary) return { base: null, ours: null, theirs: null, merged: '', binary: true, ...labels }
  return { base: base.text, ours: ours.text, theirs: theirs.text, merged: worktree.text ?? '', binary: false, ...labels }
}

/**
 * Write the resolved content of a conflicted file (atomically, keeping its mode) and
 * optionally stage it (`git add`), which marks it resolved. Only allowed while `path`
 * is unmerged; refuses to mark resolved while conflict markers remain.
 */
export async function saveConflictResolution(
  repoPath: string,
  path: string,
  content: string,
  opts: { markResolved: boolean },
): Promise<void> {
  if (typeof content !== 'string') throw new GitError('INVALID_ARGUMENT', 'Invalid content')
  const entries = await requireUnmerged(repoPath, path)
  if (opts.markResolved && hasConflictMarkers(content)) {
    throw new GitError('INVALID_ARGUMENT', 'The file still contains conflict markers')
  }
  if (path.split(/[/\\]/).some((seg) => seg.toLowerCase() === '.git')) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid path')
  }

  // Missing in the worktree: take the executable bit from the index stages.
  const exec = entries.some((x) => x.mode === '100755')
  await writeRepoFile(repoPath, path, content, exec ? 0o755 : 0o644)

  if (opts.markResolved) {
    await runGit(['add', '--', path], { cwd: repoPath, env: LITERAL_PATHSPECS_ENV, timeoutMs: INDEX_TIMEOUT })
  }
}



const BINARY_SNIFF_BYTES = 8000

/** Attributes that make git treat a file as binary for merging (or as LFS pointers). */
async function attributesSayBinary(repoPath: string, path: string): Promise<boolean> {
  const r = await runGit(['check-attr', '-z', 'diff', 'merge', 'filter', '--', path], {
    cwd: repoPath,
    env: LITERAL_PATHSPECS_ENV,
  })
  const f = r.stdout.split('\0')
  const attrs = new Map<string, string>()
  for (let i = 0; i + 2 < f.length; i += 3) attrs.set(f[i + 1]!, f[i + 2]!)
  return attrs.get('diff') === 'unset' || ['unset', 'binary'].includes(attrs.get('merge') ?? '') || attrs.get('filter') === 'lfs'
}

async function blobIsBinary(repoPath: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id)) throw new GitError('INTERNAL', 'Unexpected object id')
  const r = await runGit(['cat-file', 'blob', id], {
    cwd: repoPath,
    maxOutputBytes: BINARY_SNIFF_BYTES,
    truncateOutput: true,
  })
  return r.stdout.includes('\0')
}

/** Classify the conflict on `path`. INVALID_ARGUMENT if `path` is not currently unmerged. */
export async function describeConflict(repoPath: string, path: string): Promise<ConflictDescription> {
  const entries = await requireUnmerged(repoPath, path)
  const stages = [...new Set(entries.map((e) => e.stage))].sort((a, b) => a - b)
  const has = (n: number): boolean => stages.includes(n)
  const special = entries.some((e) => e.mode === '160000' || e.mode === '120000')
  const binary =
    !special &&
    ((await attributesSayBinary(repoPath, path)) ||
      (await Promise.all(entries.map((e) => blobIsBinary(repoPath, e.id)))).some(Boolean))

  let kind: ConflictKind
  let deletedBy: 'ours' | 'theirs' | null = null
  if (special) kind = 'other'
  else if (has(1) && has(2) && has(3)) kind = binary ? 'binary' : 'content'
  else if (!has(1) && has(2) && has(3)) kind = binary ? 'binary' : 'add-add'
  else if (has(1) && has(2) !== has(3)) {
    kind = 'modify-delete'
    deletedBy = has(2) ? 'theirs' : 'ours'
  } else kind = 'other'
  return { kind, stages, deletedBy, binary }
}

export async function getConflictKind(repoPath: string, path: string): Promise<ConflictKind> {
  return (await describeConflict(repoPath, path)).kind
}

/**
 * Resolve a conflicted path by taking one side as a whole (works for binary files):
 * - `ours` / `theirs`: `git checkout --ours|--theirs -- <path>` then `git add -- <path>`;
 *   if the chosen side deleted the file, `git rm -- <path>` instead
 * - `delete`: `git rm --quiet -- <path>`
 * "ours" is index stage 2 and "theirs" stage 3, as in git (during a rebase "ours" is the branch
 * being rebased onto). This replaces the worktree file, so callers must confirm with the user.
 * Only allowed while `path` is unmerged; no other path is touched.
 */
export async function resolveConflictWith(
  repoPath: string,
  path: string,
  choice: 'ours' | 'theirs' | 'delete',
): Promise<void> {
  if (choice !== 'ours' && choice !== 'theirs' && choice !== 'delete') {
    throw new GitError('INVALID_ARGUMENT', 'Invalid conflict resolution')
  }
  if (path.split(/[/\\]/).some((seg) => seg.toLowerCase() === '.git')) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid path')
  }
  const entries = await requireUnmerged(repoPath, path)
  const opts = { cwd: repoPath, env: LITERAL_PATHSPECS_ENV, timeoutMs: INDEX_TIMEOUT }
  const stage = choice === 'ours' ? 2 : choice === 'theirs' ? 3 : 0
  if (choice === 'delete' || !entries.some((e) => e.stage === stage)) {
    await runGit(['rm', '--quiet', '--', path], opts)
    return
  }
  await runGit(['checkout', choice === 'ours' ? '--ours' : '--theirs', '--', path], opts)
  await runGit(['add', '--', path], opts)
}

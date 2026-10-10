import { constants, type Stats } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { stagedOldPath, type DiffTargetInput } from './diff'
import { GitError } from './errors'
import { resolveRepoPath } from './paths'
import { runGit } from './runner'
import type { FileContents } from '@shared/types'
export type { FileContents }


const SHA_RE = /^[0-9a-f]{4,64}$/i
const OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Git looks for a NUL byte in the first 8000 bytes to decide a file is binary. */
const BINARY_SNIFF_BYTES = 8000

/** One side of a comparison before the binary/size rules are combined. */
export interface ContentSide {
  text: string | null
  binary: boolean
  tooLarge: boolean
}

const ABSENT: ContentSide = { text: null, binary: false, tooLarge: false }

function hasNul(text: string): boolean {
  return text.slice(0, BINARY_SNIFF_BYTES).includes('\0')
}

/**
 * Look up blobs by revision syntax (`HEAD:path`, `:0:path`, `<sha>:path`) without
 * failing on missing ones. Specs go through stdin, so they can never be parsed as options.
 * Returns, per spec, the object id and size of a blob, or null if absent / not a blob.
 */
export async function lookupBlobs(
  repoPath: string,
  specs: readonly string[],
): Promise<({ id: string; size: number } | null)[]> {
  if (specs.length === 0) return []
  for (const s of specs) {
    if (s.includes('\n') || s.includes('\0')) {
      throw new GitError('INVALID_ARGUMENT', 'Paths containing line breaks are not supported here')
    }
  }
  const r = await runGit(['cat-file', '--batch-check'], { cwd: repoPath, input: specs.map((s) => s + '\n').join('') })
  const lines = r.stdout.split('\n')
  return specs.map((_, i) => {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(lines[i] ?? '')
    if (!m || m[2] !== 'blob') return null
    return { id: m[1]!, size: Number(m[3]) }
  })
}

/** Read a blob by object id, applying the size limit and binary detection. */
export async function readBlob(
  repoPath: string,
  blob: { id: string; size: number } | null,
  maxBytes: number,
): Promise<ContentSide> {
  if (!blob) return ABSENT
  if (blob.size > maxBytes) return { text: null, binary: false, tooLarge: true }
  if (!OBJECT_ID_RE.test(blob.id)) throw new GitError('INTERNAL', 'Unexpected object id')
  const r = await runGit(['cat-file', 'blob', blob.id], {
    cwd: repoPath,
    maxOutputBytes: maxBytes,
    truncateOutput: true,
  })
  if (r.truncated) return { text: null, binary: false, tooLarge: true }
  return { text: r.stdout, binary: hasNul(r.stdout), tooLarge: false }
}

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Real path of `absDir`'s nearest existing ancestor must lie inside the repository,
 * so a symlinked directory cannot redirect reads or writes outside it.
 */
export async function assertDirInsideRepo(repoPath: string, absDir: string): Promise<string | null> {
  const root = await realpath(repoPath)
  let dir = absDir
  for (;;) {
    try {
      const real = await realpath(dir)
      if (!isInside(root, real)) {
        throw new GitError('INVALID_ARGUMENT', 'Path resolves outside the repository')
      }
      return dir === absDir ? real : null
    } catch (e) {
      if (e instanceof GitError) throw e
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
}

function rejectGitDir(relPath: string): void {
  if (relPath.split(/[/\\]/).some((seg) => seg.toLowerCase() === '.git')) {
    throw new GitError('INVALID_ARGUMENT', `Path must not be inside the .git directory: ${relPath}`)
  }
}

/**
 * Read a worktree file. Symlinks are not followed: like Git, their content is the
 * link target. Directories (e.g. submodules) and missing files read as absent.
 */
export async function readWorktreeFile(repoPath: string, relPath: string, maxBytes: number): Promise<ContentSide> {
  rejectGitDir(relPath)
  const abs = resolveRepoPath(repoPath, relPath)
  const realDir = await assertDirInsideRepo(repoPath, dirname(abs))
  if (realDir === null) return ABSENT
  const file = join(realDir, basename(abs))

  let st: Stats
  try {
    st = await lstat(file)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return ABSENT
    throw e
  }
  if (st.isSymbolicLink()) {
    const target = await readlink(file)
    return { text: target, binary: false, tooLarge: false }
  }
  if (!st.isFile()) return ABSENT
  if (st.size > maxBytes) return { text: null, binary: false, tooLarge: true }

  // O_NOFOLLOW guards against the file being swapped for a symlink after lstat (not on Windows).
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const hst = await handle.stat()
    if (!hst.isFile()) return ABSENT
    if (hst.size > maxBytes) return { text: null, binary: false, tooLarge: true }
    const buf = await handle.readFile()
    if (buf.length > maxBytes) return { text: null, binary: false, tooLarge: true }
    const binary = buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    return { text: binary ? null : buf.toString('utf8'), binary, tooLarge: false }
  } finally {
    await handle.close()
  }
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

function combine(oldSide: ContentSide, newSide: ContentSide): FileContents {
  const binary = oldSide.binary || newSide.binary || hasNul(oldSide.text ?? '') || hasNul(newSide.text ?? '')
  const tooLarge = oldSide.tooLarge || newSide.tooLarge
  if (binary || tooLarge) return { oldText: null, newText: null, binary, tooLarge }
  return { oldText: oldSide.text, newText: newSide.text, binary: false, tooLarge: false }
}

/**
 * Both full sides of a file for `target`:
 * - unstaged: index (stage 0, or "ours" stage 2 for an unmerged file) vs worktree
 * - staged: HEAD (`HEAD:<oldPath>` for a staged rename given `oldPath`) vs index
 * - untracked: nothing vs worktree
 * - commit: first parent (`oldPath` if renamed) vs the commit
 * A side that does not exist is null. Binary (NUL in the first 8000 bytes) or
 * larger-than-`maxBytes` (default 5 MiB) content yields null texts with the flag set.
 */
export async function getFileContents(
  repoPath: string,
  target: DiffTargetInput,
  opts: { maxBytes?: number } = {},
): Promise<FileContents> {
  const path = target.path
  resolveRepoPath(repoPath, path)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new GitError('INVALID_ARGUMENT', 'Invalid size limit')

  switch (target.kind) {
    case 'unstaged': {
      // Explicit `:0:` so a path like `1:x` cannot be read as a stage number.
      const [stage0, stage2] = await lookupBlobs(repoPath, [`:0:${path}`, `:2:${path}`])
      const [oldSide, newSide] = await Promise.all([
        readBlob(repoPath, stage0 ?? stage2 ?? null, maxBytes),
        readWorktreeFile(repoPath, path, maxBytes),
      ])
      return combine(oldSide, newSide)
    }
    case 'staged': {
      // On an unborn branch `HEAD:path` is simply missing.
      const oldPath = stagedOldPath(repoPath, target) ?? path
      const [head, index] = await lookupBlobs(repoPath, [`HEAD:${oldPath}`, `:0:${path}`])
      const [oldSide, newSide] = await Promise.all([
        readBlob(repoPath, head ?? null, maxBytes),
        readBlob(repoPath, index ?? null, maxBytes),
      ])
      return combine(oldSide, newSide)
    }
    case 'untracked':
      return combine(ABSENT, await readWorktreeFile(repoPath, path, maxBytes))
    case 'commit': {
      if (target.oldPath !== undefined) resolveRepoPath(repoPath, target.oldPath)
      const { sha, parent } = await resolveCommit(repoPath, target.sha)
      const specs = [`${sha}:${path}`]
      if (parent) specs.push(`${parent}:${target.oldPath ?? path}`)
      const [cur, prev] = await lookupBlobs(repoPath, specs)
      const [oldSide, newSide] = await Promise.all([
        readBlob(repoPath, prev ?? null, maxBytes),
        readBlob(repoPath, cur ?? null, maxBytes),
      ])
      return combine(oldSide, newSide)
    }
    default:
      throw new GitError('INVALID_ARGUMENT', 'Invalid diff target')
  }
}

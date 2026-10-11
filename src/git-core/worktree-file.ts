import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { assertDirInsideRepo, readWorktreeFile } from './contents'
import { GitError } from './errors'
import { resolveRepoPath } from './paths'

const MAX_EDIT_BYTES = 5 * 1024 * 1024

export const contentHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function rejectGitDir(path: string): void {
  if (path.split(/[/\\]/).some((seg) => seg.toLowerCase() === '.git')) throw new GitError('INVALID_ARGUMENT', 'Invalid path')
}

/**
 * Atomically write a working-tree file: temp file in the same directory, fsync, rename. Refuses
 * symlinks and non-regular files, and any path that resolves outside the repository. Keeps the
 * existing file's permission bits; new files get `newFileMode`.
 */
export async function writeRepoFile(repoPath: string, path: string, content: string, newFileMode = 0o644): Promise<void> {
  if (typeof content !== 'string') throw new GitError('INVALID_ARGUMENT', 'Invalid content')
  rejectGitDir(path)
  const abs = resolveRepoPath(repoPath, path)
  const dir = dirname(abs)
  // The nearest existing ancestor must resolve inside the repository before anything is created.
  await assertDirInsideRepo(repoPath, dir)
  await mkdir(dir, { recursive: true })
  const realDir = await assertDirInsideRepo(repoPath, dir)
  if (realDir === null) throw new GitError('INTERNAL', 'Could not create the directory for the file')
  const file = join(realDir, basename(abs))

  let mode = newFileMode
  try {
    const st = await lstat(file)
    if (st.isSymbolicLink()) throw new GitError('INVALID_ARGUMENT', `Cannot write over a symbolic link: ${path}`)
    if (!st.isFile()) throw new GitError('INVALID_ARGUMENT', `Not a regular file: ${path}`)
    mode = st.mode & 0o777
  } catch (e) {
    if (e instanceof GitError) throw e
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  const tmp = join(realDir, `.${basename(abs)}.gitbob-${randomBytes(6).toString('hex')}.tmp`)
  try {
    const handle = await open(tmp, 'wx', mode)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.chmod(mode) // creation mode is subject to the umask
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/** A working-tree text file for editing, with a hash of exactly what was read. */
export async function readFileForEdit(repoPath: string, path: string): Promise<{ text: string; hash: string }> {
  rejectGitDir(path)
  const side = await readWorktreeFile(repoPath, path, MAX_EDIT_BYTES)
  if (side.tooLarge) throw new GitError('INVALID_ARGUMENT', 'This file is too large to edit here (over 5 MB).')
  if (side.binary) throw new GitError('INVALID_ARGUMENT', 'Binary files can’t be edited here.')
  if (side.text === null) throw new GitError('NOT_FOUND', `${path} does not exist in the working tree`)
  const st = await lstat(resolveRepoPath(repoPath, path))
  if (st.isSymbolicLink()) throw new GitError('INVALID_ARGUMENT', 'Symbolic links can’t be edited here.')
  return { text: side.text, hash: contentHash(side.text) }
}

/**
 * Save an edited file only if it still has the content the editor started from (`baseHash`), so
 * changes made by another program in the meantime are never overwritten.
 */
export async function saveEditedFile(repoPath: string, path: string, content: string, baseHash: string): Promise<{ hash: string }> {
  if (!/^[0-9a-f]{64}$/.test(baseHash)) throw new GitError('INVALID_ARGUMENT', 'Invalid content hash')
  if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) throw new GitError('INVALID_ARGUMENT', 'The file is too large to save here.')
  const current = await readFileForEdit(repoPath, path)
  if (current.hash !== baseHash) {
    throw new GitError('GIT_FAILED', `${path} was changed outside GitBob since you opened it. Reopen it to see those changes; your edits were not saved.`)
  }
  await writeRepoFile(repoPath, path, content)
  return { hash: contentHash(content) }
}

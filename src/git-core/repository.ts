import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import type { RepositoryInfo } from '@shared/types'
import { GitError } from './errors'
import { runGit } from './runner'
import { nativePath } from './paths'

/** Resolve and validate a path as a Git repository. */
export async function openRepository(inputPath: string): Promise<RepositoryInfo> {
  if (!isAbsolute(inputPath)) throw new GitError('INVALID_ARGUMENT', 'Repository path must be absolute')
  const path = resolve(inputPath)

  try {
    const s = await stat(path)
    if (!s.isDirectory()) throw new GitError('NOT_A_REPOSITORY', `Not a directory: ${path}`)
  } catch (e) {
    if (e instanceof GitError) throw e
    throw new GitError('NOT_FOUND', `Folder does not exist: ${path}`)
  }

  let out: string
  try {
    out = (await runGit(['rev-parse', '--is-bare-repository', '--absolute-git-dir'], { cwd: path, timeoutMs: 10_000 }))
      .stdout
  } catch (e) {
    if (e instanceof GitError && e.code === 'GIT_FAILED') {
      if (/dubious ownership/i.test(e.detail ?? '')) {
        throw new GitError(
          'NOT_A_REPOSITORY',
          'Git refused to open this repository because it is owned by another user (safe.directory).',
          { detail: e.detail },
        )
      }
      throw new GitError('NOT_A_REPOSITORY', `Not a Git repository: ${path}`, { detail: e.detail })
    }
    throw e
  }

  const [bareLine, gitDir] = out.split('\n')
  const bare = bareLine?.trim() === 'true'
  if (!gitDir) throw new GitError('INTERNAL', 'Unexpected rev-parse output')

  const gitDirNative = nativePath(gitDir)
  let root = gitDirNative
  if (!bare) {
    // When opened from inside a non-bare repository's .git directory there is no work tree
    // at `path`; resolve the top level from the directory that contains the git dir instead.
    const dir = gitDirNative
    const cwd = (path + sep).startsWith(dir + sep) ? dirname(dir) : path
    try {
      root = nativePath((await runGit(['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10_000 })).stdout)
    } catch (e) {
      if (e instanceof GitError && e.code === 'GIT_FAILED') {
        throw new GitError('NOT_A_REPOSITORY', `Could not determine the work tree for ${path}`, { detail: e.detail })
      }
      throw e
    }
  }

  return { root, gitDir: gitDirNative, bare, name: basename(root.replace(/[\\/]\.git$/, '')) }
}

import { isAbsolute, resolve, sep } from 'node:path'
import { GitError } from './errors'

/** Environment for commands taking user paths: pathspecs are matched literally (no glob or magic). */
export const LITERAL_PATHSPECS_ENV: Record<string, string> = { GIT_LITERAL_PATHSPECS: '1' }

/**
 * Validate a repository-relative path and return its absolute location.
 * Rejects empty values, NUL bytes, absolute/drive paths and any `..` segment,
 * and double-checks that the resolved path stays inside `root`.
 */
export function resolveRepoPath(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid path')
  }
  if (isAbsolute(relPath) || /^([/\\]|[a-zA-Z]:)/.test(relPath)) {
    throw new GitError('INVALID_ARGUMENT', `Path must be relative to the repository: ${relPath}`)
  }
  if (relPath.split(/[/\\]/).includes('..')) {
    throw new GitError('INVALID_ARGUMENT', `Path must not leave the repository: ${relPath}`)
  }
  const base = resolve(root)
  const abs = resolve(base, relPath)
  if (abs === base || !abs.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new GitError('INVALID_ARGUMENT', `Path must be inside the repository: ${relPath}`)
  }
  return abs
}

/** Validate every path; throws before any side effect if one is invalid. */
export function validateRepoPaths(root: string, paths: readonly string[]): string[] {
  return paths.map((p) => resolveRepoPath(root, p))
}

/** NUL-separated pathspec list for `--pathspec-from-file=- --pathspec-file-nul`. */
export function pathspecInput(paths: readonly string[]): string {
  return paths.map((p) => p + '\0').join('')
}

export const PATHSPEC_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'] as const

/**
 * Git reports paths with forward slashes on Windows ("C:/Users/x"); everything else in GitBob
 * (Node, dialogs, the UI, authorization checks) uses native paths ("C:\\Users\\x").
 * Convert a path printed by git into the native absolute form. A no-op on macOS/Linux.
 */
export function nativePath(gitPath: string, platform: NodeJS.Platform = process.platform): string {
  const p = gitPath.trim()
  if (platform !== 'win32') return p
  // Only drive-letter ("C:/x") and UNC ("//server/share") paths are converted.
  return /^[A-Za-z]:\//.test(p) || p.startsWith('//') ? p.replace(/\//g, '\\') : p
}

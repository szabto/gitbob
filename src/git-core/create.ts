import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseProgress } from './askpass'
import { assertValidBranchName } from './branches'
import { GitError } from './errors'
import type { NetworkOptions } from './remotes'
import { runGit } from './runner'
import { networkEnv } from './network-env'

/** Cloning a large repository can take a long time; it must still never hang forever. */
const CLONE_TIMEOUT = 60 * 60_000
const MAX_DEPTH = 1_000_000

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * Make `name` safe as a single folder name on Windows, macOS and Linux: drops
 * path separators, characters Windows rejects and control characters, trims
 * trailing dots/spaces, and avoids reserved device names. Never returns '',
 * '.' or '..' (falls back to 'repository').
 */
export function sanitizeFolderName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '').trim()
  s = s.replace(/[. ]+$/, '')
  if (!s || s === '.' || s === '..') return 'repository'
  if (WINDOWS_RESERVED.test(s)) s = `${s}_`
  // Keep well under common file-name limits (255 bytes).
  if (Buffer.byteLength(s) > 200) s = Buffer.from(s).subarray(0, 200).toString('utf8').replace(/\uFFFD+$/, '')
  return s || 'repository'
}

/**
 * The folder name git would pick for a clone of `url` ("humanish" part),
 * sanitized with {@link sanitizeFolderName}.
 */
export function repoNameFromUrl(url: string): string {
  let s = url.trim().replace(/[/\\]+$/, '')
  // `/path/repo/.git` -> `/path/repo`
  s = s.replace(/[/\\]\.git$/i, '').replace(/[/\\]+$/, '')
  s = s.replace(/\.git$/i, '').replace(/[/\\]+$/, '')
  // The last path segment; for scp-like `host:repo` and `ssh://host:22` the part after ':'.
  const seg = s.split(/[/\\]/).pop() ?? ''
  const last = seg.includes(':') ? seg.slice(seg.lastIndexOf(':') + 1) : seg
  return sanitizeFolderName(last)
}

/** Network URL with a host that cannot be mistaken for an ssh option (CVE-2017-1000117). */
const NETWORK_URL_RE = /^(?:https?|ssh|git):\/\/(?:[^/@]+@)?(?:[A-Za-z0-9_.~%]|\[)[^/@]*(?:\/.*)?$/i
const FILE_URL_RE = /^file:\/\/.+/i
const SCP_LIKE_RE = /^[A-Za-z0-9._~+-]+@(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[0-9A-Fa-f:.]+\]):(?!\/\/).+$/
/** git's `<transport>::<address>` syntax runs a remote helper (`ext::` can run any command). */
const REMOTE_HELPER_RE = /^[A-Za-z][A-Za-z0-9+.-]*::/

/** Reject anything but plain https/http/ssh/git/file URLs, scp-like `user@host:path` or absolute local paths. */
export function assertValidCloneUrl(url: string): void {
  const bad = (why: string): never => {
    throw new GitError('INVALID_ARGUMENT', `Invalid repository URL: ${why}`)
  }
  if (typeof url !== 'string' || url.length === 0) bad('it is empty')
  if (url.length > 4096) bad('it is too long')
  if (url.startsWith('-')) bad('it must not start with "-"')
  if (/[\s\0]/.test(url)) bad('it must not contain whitespace or control characters')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) bad('it must not contain control characters')
  if (REMOTE_HELPER_RE.test(url) || /^(?:ext|fd)::/i.test(url)) bad('remote helper transports are not allowed')
  if (NETWORK_URL_RE.test(url) || FILE_URL_RE.test(url)) return
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) bad('unsupported protocol or invalid host')
  if (SCP_LIKE_RE.test(url)) return
  if (isAbsolute(url)) return
  bad('use an https://, ssh://, git:// or file:// URL, user@host:path, or an absolute local path')
}


function mapNetworkError(e: unknown): never {
  if (e instanceof GitError && e.code === 'GIT_FAILED') {
    const d = e.detail ?? ''
    if (
      /terminal prompts disabled|could not read Username|could not read Password|Authentication failed|Permission denied \(publickey/i.test(
        d,
      )
    ) {
      throw new GitError('GIT_FAILED', 'Authentication failed. Configure an SSH key or a Git credential helper.', {
        detail: d,
      })
    }
    if (/Host key verification failed/i.test(d)) {
      throw new GitError('GIT_FAILED', 'Host key verification failed. Connect once with ssh to trust the host.', {
        detail: d,
      })
    }
    if (/already exists and is not an empty directory/i.test(d)) {
      throw new GitError('INVALID_ARGUMENT', 'The destination folder already exists and is not empty.', { detail: d })
    }
  }
  throw e
}

async function assertDirectory(dir: string, what: string): Promise<void> {
  if (!isAbsolute(dir)) throw new GitError('INVALID_ARGUMENT', `${what} must be an absolute path`)
  let s
  try {
    s = await stat(dir)
  } catch {
    throw new GitError('NOT_FOUND', `${what} does not exist: ${dir}`)
  }
  if (!s.isDirectory()) throw new GitError('INVALID_ARGUMENT', `${what} is not a folder: ${dir}`)
}

/** 'missing', 'empty' (an empty directory) or 'occupied' (anything else, including files and symlinks). */
async function targetState(path: string): Promise<'missing' | 'empty' | 'occupied'> {
  let s
  try {
    s = await lstat(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw e
  }
  if (!s.isDirectory()) return 'occupied'
  return (await readdir(path)).length === 0 ? 'empty' : 'occupied'
}

export interface CloneOptions extends NetworkOptions {
  /** Folder name inside `parentDir`; defaults to {@link repoNameFromUrl}. Must be a plain folder name. */
  name?: string
  /** Shallow clone with this many commits (`--depth`). Ignored by git for plain local-path clones. */
  depth?: number
}

/**
 * Clone `url` into `parentDir/<name>` with `git clone --progress`.
 *
 * Refuses an existing non-empty destination. If git fails or is cancelled and
 * the destination did not exist before, the partially created folder is
 * removed; a pre-existing empty folder is left in place (git itself removes
 * what it wrote there).
 */
export async function cloneRepository(url: string, parentDir: string, opts: CloneOptions = {}): Promise<{ path: string }> {
  assertValidCloneUrl(url)
  await assertDirectory(parentDir, 'Destination folder')
  let name: string
  if (opts.name !== undefined) {
    const trimmed = typeof opts.name === 'string' ? opts.name.trim() : ''
    if (!trimmed || sanitizeFolderName(trimmed) !== trimmed) {
      throw new GitError('INVALID_ARGUMENT', `Invalid folder name: ${String(opts.name)}`)
    }
    name = trimmed
  } else {
    name = repoNameFromUrl(url)
  }
  if (opts.depth !== undefined && (!Number.isInteger(opts.depth) || opts.depth < 1 || opts.depth > MAX_DEPTH)) {
    throw new GitError('INVALID_ARGUMENT', 'Clone depth must be a positive whole number')
  }
  const parent = resolve(parentDir)
  const target = join(parent, name)
  const before = await targetState(target)
  if (before === 'occupied') throw new GitError('INVALID_ARGUMENT', `The folder already exists: ${target}`)
  if (opts.signal?.aborted) throw new GitError('CANCELLED', 'Git command was cancelled')

  const onProgress = opts.onProgress
  const args = [
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.fd.allow=never',
    'clone',
    '--progress',
    ...(opts.depth !== undefined ? ['--depth', String(opts.depth)] : []),
    '--',
    url,
    target,
  ]
  try {
    await runGit(args, {
      cwd: parent,
      env: await networkEnv(parent, opts.env),
      timeoutMs: CLONE_TIMEOUT,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(onProgress
        ? {
            onStderr: (chunk: string) => {
              const p = parseProgress(chunk)
              if (p) onProgress(p)
            },
          }
        : {}),
    })
  } catch (e) {
    if (before === 'missing') {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
    }
    mapNetworkError(e)
  }
  return { path: target }
}

/** Closest existing ancestor directory of `dir` (or `dir` itself). */
async function existingAncestor(dir: string): Promise<string> {
  let cur = dir
  for (;;) {
    try {
      if ((await stat(cur)).isDirectory()) return cur
    } catch {
      /* keep walking up */
    }
    const up = dirname(cur)
    if (up === cur) return cur
    cur = up
  }
}

/**
 * `git init [--initial-branch=<name>] -- <dir>`; creates `dir` (and missing
 * parents) if needed. Nested repositories are allowed, but a folder that
 * already has a `.git` entry is refused.
 */
export async function initRepository(dir: string, opts: { initialBranch?: string } = {}): Promise<void> {
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0')) {
    throw new GitError('INVALID_ARGUMENT', 'Repository folder must be an absolute path')
  }
  const path = resolve(dir)
  try {
    const s = await stat(path)
    if (!s.isDirectory()) throw new GitError('INVALID_ARGUMENT', `Not a folder: ${path}`)
  } catch (e) {
    if (e instanceof GitError) throw e
  }
  if ((await targetState(join(path, '.git'))) !== 'missing') {
    throw new GitError('INVALID_ARGUMENT', `The folder is already a Git repository: ${path}`)
  }
  const cwd = await existingAncestor(path)
  const args = ['init']
  if (opts.initialBranch !== undefined) {
    await assertValidBranchName(cwd, opts.initialBranch)
    args.push(`--initial-branch=${opts.initialBranch}`)
  }
  args.push('--', path)
  await runGit(args, { cwd })
}

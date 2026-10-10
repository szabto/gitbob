import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitError } from './errors'
import { networkEnv } from './network-env'
import { nativePath } from './paths'
import { runGit } from './runner'
import type { LfsTrackedPattern, LfsFile, LfsStatus } from '@shared/types'
export type { LfsTrackedPattern, LfsFile, LfsStatus }

/**
 * Git LFS through the real `git lfs` CLI (git-lfs must be installed; GitBob does not bundle it).
 *
 * Tracked patterns come from `git lfs track --json` (git-lfs >= 3.x), falling back to parsing
 * the human "Listing tracked patterns" output of older versions. git-lfs itself resolves every
 * attributes source (root and nested .gitattributes, .git/info/attributes), so this is more
 * accurate than reading .gitattributes files ourselves. Without git-lfs nothing is listed.
 */




export const LFS_FILES_LIMIT = 5000
const LFS_TIMEOUT = 120_000
/** LFS transfers move large binaries; allow far longer than ordinary git network commands. */
const LFS_NETWORK_TIMEOUT = 60 * 60_000
const MAX_PATTERN_LENGTH = 200

/** Version string of git-lfs, or null if `git lfs` is not available. */
export async function getLfsVersion(repoPath: string): Promise<string | null> {
  try {
    const r = await runGit(['lfs', 'version'], { cwd: repoPath, timeoutMs: LFS_TIMEOUT })
    const v = r.stdout.trim()
    return /^git-lfs\//.test(v) ? v : null
  } catch (e) {
    if (e instanceof GitError && (e.code === 'GIT_FAILED' || e.code === 'GIT_NOT_FOUND')) return null
    throw e
  }
}

async function requireLfs(repoPath: string): Promise<void> {
  if ((await getLfsVersion(repoPath)) === null) {
    throw new GitError('GIT_FAILED', 'Git LFS is not installed. Install git-lfs and try again.')
  }
}

async function lfsFiltersConfigured(repoPath: string): Promise<boolean> {
  const r = await runGit(['config', '--get-regexp', '^filter\\.lfs\\.(process|smudge)$'], {
    cwd: repoPath,
    okExitCodes: [0, 1],
  })
  return r.stdout.split('\n').some((l) => /^filter\.lfs\.(process|smudge) \S/.test(l))
}

/** Parse the JSON or human-readable output of `git lfs track`. */
export function parseLfsTrackOutput(stdout: string): LfsTrackedPattern[] {
  const text = stdout.trim()
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text) as { patterns?: { pattern?: unknown; source?: unknown; tracked?: unknown }[] }
    return (parsed.patterns ?? [])
      .filter((p) => typeof p.pattern === 'string' && typeof p.source === 'string' && p.tracked !== false)
      .map((p) => ({ pattern: p.pattern as string, source: p.source as string }))
  }
  const out: LfsTrackedPattern[] = []
  let inTracked = false
  for (const line of text.split('\n')) {
    if (/^Listing tracked patterns/.test(line)) {
      inTracked = true
      continue
    }
    if (/^Listing /.test(line)) {
      inTracked = false
      continue
    }
    if (!inTracked) continue
    // "    <pattern> (<source>)". Patterns cannot contain a literal space (git-lfs escapes them).
    const m = /^\s+(\S+) \((.+)\)$/.exec(line)
    if (m) out.push({ pattern: m[1]!, source: m[2]! })
  }
  return out
}

/** Parse `git lfs ls-files --long`: "<oid> <*|-> <path>". */
export function parseLfsLsFiles(stdout: string): LfsFile[] {
  const files: LfsFile[] = []
  for (const line of stdout.split('\n')) {
    const m = /^([0-9a-f]{64}) ([*-]) (.+)$/.exec(line)
    if (m) files.push({ oid: m[1]!, downloaded: m[2] === '*', path: m[3]! })
  }
  return files
}

async function trackedPatterns(repoPath: string): Promise<LfsTrackedPattern[]> {
  try {
    const json = await runGit(['lfs', 'track', '--json'], { cwd: repoPath, timeoutMs: LFS_TIMEOUT })
    if (json.stdout.trim().startsWith('{')) return parseLfsTrackOutput(json.stdout)
  } catch (e) {
    // git-lfs < 3 has no --json; anything other than a git failure is real.
    if (!(e instanceof GitError && e.code === 'GIT_FAILED') && !(e instanceof SyntaxError)) throw e
  }
  const text = await runGit(['lfs', 'track'], { cwd: repoPath, timeoutMs: LFS_TIMEOUT })
  return parseLfsTrackOutput(text.stdout)
}

async function lfsFiles(repoPath: string): Promise<{ files: LfsFile[]; truncated: boolean }> {
  // On an unborn branch there is nothing to list (and older git-lfs versions fail there).
  const head = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1] })
  if (head.exitCode !== 0) return { files: [], truncated: false }
  const r = await runGit(['lfs', 'ls-files', '--long'], {
    cwd: repoPath,
    timeoutMs: LFS_TIMEOUT,
    // Generous cap: a line is "<64 hex> <flag> <path>"; LFS_FILES_LIMIT lines fit easily.
    maxOutputBytes: 32 * 1024 * 1024,
    truncateOutput: true,
  })
  const files = parseLfsLsFiles(r.truncated ? r.stdout.slice(0, r.stdout.lastIndexOf('\n') + 1) : r.stdout)
  const truncated = r.truncated === true || files.length > LFS_FILES_LIMIT
  return { files: files.slice(0, LFS_FILES_LIMIT), truncated }
}

/** LFS availability and state of `repoPath`. Never throws just because git-lfs is missing. */
export async function getLfsStatus(repoPath: string): Promise<LfsStatus> {
  const [version, enabledInRepo] = await Promise.all([getLfsVersion(repoPath), lfsFiltersConfigured(repoPath)])
  if (version === null) {
    // Without git-lfs we can still tell from the top-level .gitattributes that the repository
    // uses LFS, so the app can say "git-lfs is missing" instead of silently showing pointers.
    return { installed: false, version: null, enabledInRepo, trackedPatterns: await attributesPatterns(repoPath), files: [], filesTruncated: false }
  }
  const [patterns, { files, truncated }] = await Promise.all([trackedPatterns(repoPath), lfsFiles(repoPath)])
  return { installed: true, version, enabledInRepo, trackedPatterns: patterns, files, filesTruncated: truncated }
}

/** Configure the LFS filters and hooks for this repository only (`git lfs install --local`). */
export async function installLfs(repoPath: string): Promise<void> {
  await requireLfs(repoPath)
  await runGit(['lfs', 'install', '--local'], { cwd: repoPath, timeoutMs: LFS_TIMEOUT }).catch((e: unknown) => {
    if (e instanceof GitError && /Hook already exists/i.test(`${e.detail ?? ''}`)) {
      throw new GitError(
        'GIT_FAILED',
        'Git LFS could not install its hooks because the repository already has its own. Merge them manually or run "git lfs update --manual".',
        { detail: e.detail },
      )
    }
    throw e
  })
}

export function assertValidLfsPattern(pattern: string): void {
  if (
    typeof pattern !== 'string' ||
    pattern.trim().length === 0 ||
    pattern.length > MAX_PATTERN_LENGTH ||
    // eslint-disable-next-line no-control-regex
    /[\0-\x1f\x7f]/.test(pattern) ||
    pattern.startsWith('-') ||
    // A leading '#' would be a comment and '!' a negative pattern, which attributes do not allow.
    pattern.startsWith('#') ||
    pattern.startsWith('!')
  ) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid LFS pattern')
  }
}

export interface LfsTrackResult {
  /** True if the attributes file was changed (false if the pattern was already tracked / not tracked). */
  changed: boolean
  /** Repository-relative attributes file git-lfs edits. It is not staged; that is left to the user. */
  attributesPath: string
  /** Absolute native path of that file. */
  attributesAbsPath: string
}

async function topLevel(repoPath: string): Promise<string> {
  const r = await runGit(['rev-parse', '--show-toplevel'], { cwd: repoPath })
  const top = r.stdout.trim()
  if (!top) throw new GitError('INVALID_ARGUMENT', 'Not a work tree')
  return nativePath(top)
}

async function editTracking(repoPath: string, verb: 'track' | 'untrack', pattern: string): Promise<LfsTrackResult> {
  assertValidLfsPattern(pattern)
  await requireLfs(repoPath)
  // Run at the top level so the pattern is relative to the repository root and lands in /.gitattributes.
  const top = await topLevel(repoPath)
  const r = await runGit(['lfs', verb, '--', pattern], { cwd: top, timeoutMs: LFS_TIMEOUT })
  const changed = verb === 'track' ? /^Tracking "/m.test(r.stdout) : /^Untracking "/m.test(r.stdout)
  return { changed, attributesPath: '.gitattributes', attributesAbsPath: join(top, '.gitattributes') }
}

/** `git lfs track -- <pattern>`: adds the pattern to the root .gitattributes (not staged). */
export function trackPattern(repoPath: string, pattern: string): Promise<LfsTrackResult> {
  return editTracking(repoPath, 'track', pattern)
}

/** `git lfs untrack -- <pattern>`: removes the pattern from the attributes (not staged). */
export function untrackPattern(repoPath: string, pattern: string): Promise<LfsTrackResult> {
  return editTracking(repoPath, 'untrack', pattern)
}

export interface LfsPullOptions {
  signal?: AbortSignal
  /** Extra environment, e.g. the GIT_ASKPASS bridge (passed through networkEnv like fetch/pull). */
  env?: Record<string, string>
}

export interface LfsPullResult {
  /**
   * True if git-lfs downloaded objects but did not replace pointers in the worktree because the
   * LFS filters are not configured for this repository (run installLfs first).
   */
  checkoutSkipped: boolean
}

/** `git lfs pull`: download the LFS objects of the current checkout and replace the pointer files. */
export async function pullLfs(repoPath: string, opts: LfsPullOptions = {}): Promise<LfsPullResult> {
  await requireLfs(repoPath)
  const r = await runGit(['lfs', 'pull'], {
    cwd: repoPath,
    env: await networkEnv(repoPath, opts.env),
    timeoutMs: LFS_NETWORK_TIMEOUT,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }).catch((e: unknown) => {
    if (e instanceof GitError && e.code === 'GIT_FAILED') {
      const d = `${e.detail ?? ''}`
      if (/Authentication required|Authorization error|could not read Username|terminal prompts disabled|Permission denied/i.test(d)) {
        throw new GitError('GIT_FAILED', 'Git LFS authentication failed. Configure credentials for the LFS server.', {
          detail: d,
        })
      }
      if (/not a git repository/i.test(d)) throw new GitError('NOT_A_REPOSITORY', 'Not a Git repository', { detail: d })
      throw new GitError('GIT_FAILED', 'Git LFS could not download the files.', { detail: d })
    }
    throw e
  })
  return { checkoutSkipped: /Skipping object checkout/i.test(`${r.stdout}\n${r.stderr}`) }
}

/** `filter=lfs` patterns from the top-level .gitattributes (used only when git-lfs is missing). */
async function attributesPatterns(repoPath: string): Promise<LfsTrackedPattern[]> {
  try {
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], { cwd: repoPath })
    const text = await readFile(join(stdout.trim(), '.gitattributes'), 'utf8')
    return text
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('#') && /\sfilter=lfs(\s|$)/.test(l))
      .map((l: string) => ({ pattern: l.split(/\s+/)[0]!, source: '.gitattributes' }))
  } catch {
    return []
  }
}

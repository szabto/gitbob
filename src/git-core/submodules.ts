import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { GitError } from './errors'
import { LITERAL_PATHSPECS_ENV, validateRepoPaths } from './paths'
import { runGit } from './runner'
import type { SubmoduleInfo } from '@shared/types'
export type { SubmoduleInfo }


export interface UpdateSubmodulesOptions {
  /** Initialize uninitialized submodules first (`--init`). */
  init: boolean
  recursive: boolean
  /** Limit to these submodule paths (repository-relative). */
  paths?: string[]
  /** Extra environment, e.g. the GIT_ASKPASS bridge. */
  env?: Record<string, string>
  signal?: AbortSignal
}

const NETWORK_TIMEOUT = 10 * 60_000
const ZERO_SHA_RE = /^0+$/

interface ModuleConfig {
  path?: string
  url?: string
  branch?: string
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Parse `git config -z --get-regexp` output of a .gitmodules file into modules keyed by name. */
export function parseGitmodules(stdout: string): Map<string, ModuleConfig> {
  const modules = new Map<string, ModuleConfig>()
  for (const entry of stdout.split('\0')) {
    if (!entry) continue
    const nl = entry.indexOf('\n')
    const key = nl === -1 ? entry : entry.slice(0, nl)
    const value = nl === -1 ? '' : entry.slice(nl + 1)
    if (!key.startsWith('submodule.')) continue
    const dot = key.lastIndexOf('.')
    if (dot <= 'submodule.'.length) continue
    const name = key.slice('submodule.'.length, dot)
    const variable = key.slice(dot + 1)
    const m = modules.get(name) ?? {}
    if (variable === 'path' || variable === 'url' || variable === 'branch') m[variable] = value
    modules.set(name, m)
  }
  return modules
}

async function readGitmodules(repoPath: string): Promise<ModuleConfig[]> {
  if (!(await exists(join(repoPath, '.gitmodules')))) return []
  const r = await runGit(
    ['config', '-f', '.gitmodules', '--no-includes', '-z', '--get-regexp', '^submodule\\..*\\.(path|url|branch)$'],
    { cwd: repoPath, okExitCodes: [0, 1] },
  )
  return [...parseGitmodules(r.stdout).values()].filter((m) => m.path)
}

/** Paths whose submodule has modified tracked content (porcelain v2 `S.M.`). */
async function dirtySubmodules(repoPath: string, paths: string[]): Promise<Set<string>> {
  const r = await runGit(
    ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=none', '--', ...paths],
    { cwd: repoPath, env: { GIT_OPTIONAL_LOCKS: '0', ...LITERAL_PATHSPECS_ENV }, timeoutMs: 120_000 },
  )
  const out = new Set<string>()
  const tokens = r.stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? ''
    const f = tok.split(' ')
    if (tok.startsWith('1 ') && f.length >= 9 && f[2]?.startsWith('S') && f[2][2] === 'M') out.add(f.slice(8).join(' '))
    else if (tok.startsWith('2 ')) {
      if (f.length >= 10 && f[2]?.startsWith('S') && f[2][2] === 'M') out.add(f.slice(9).join(' '))
      i++ // original path
    }
  }
  return out
}

/** List the submodules of the superproject at `repoPath` (not recursive). */
export async function listSubmodules(repoPath: string): Promise<SubmoduleInfo[]> {
  const modules = await readGitmodules(repoPath)
  if (modules.length === 0) return []
  const byPath = new Map(modules.map((m) => [m.path!, m]))
  // Longest first so "a b" wins over "a" when matching "a b (describe)".
  const known = [...byPath.keys()].sort((a, b) => b.length - a.length)

  const r = await runGit(['submodule', 'status'], { cwd: repoPath, timeoutMs: 120_000 })
  const parsed: { path: string; flag: string; sha: string }[] = []
  for (const line of r.stdout.split('\n')) {
    const m = /^([ +\-U])([0-9a-f]{40,64}) (.*)$/.exec(line)
    if (!m) continue
    const rest = m[3]!
    const path = known.find((p) => rest === p || rest.startsWith(`${p} (`)) ?? rest.replace(/ \([^()]*\)$/, '')
    parsed.push({ path, flag: m[1]!, sha: m[2]! })
  }
  const initialized = parsed.filter((p) => p.flag === ' ').map((p) => p.path)
  const dirty = initialized.length ? await dirtySubmodules(repoPath, initialized) : new Set<string>()

  return parsed.map(({ path, flag, sha }) => {
    const cfg = byPath.get(path)
    const status: SubmoduleInfo['status'] =
      flag === '-' ? 'uninitialized' : flag === 'U' ? 'conflict' : flag === '+' || dirty.has(path) ? 'modified' : 'clean'
    return {
      path,
      url: cfg?.url ?? null,
      sha: ZERO_SHA_RE.test(sha) ? null : sha,
      status,
      branch: cfg?.branch ?? null,
    }
  })
}

async function networkEnv(repoPath: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...extra }
  // Same policy as remotes.ts: make ssh fail fast instead of waiting on an invisible prompt,
  // unless the user configured their own ssh command.
  if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) {
    const cfg = await runGit(['config', '--get', 'core.sshCommand'], { cwd: repoPath, okExitCodes: [0, 1] })
    if (!cfg.stdout.trim()) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  return env
}

/**
 * `git submodule update` (checks out the recorded commits; may clone/fetch over the network).
 * Git refuses to check out over conflicting local changes inside a submodule.
 */
export async function updateSubmodules(repoPath: string, opts: UpdateSubmodulesOptions): Promise<void> {
  const paths = opts.paths ?? []
  if (!Array.isArray(paths)) throw new GitError('INVALID_ARGUMENT', 'Invalid submodule paths')
  validateRepoPaths(repoPath, paths)
  const args = [
    'submodule',
    'update',
    ...(opts.init ? ['--init'] : []),
    ...(opts.recursive ? ['--recursive'] : []),
    '--',
    ...paths,
  ]
  try {
    await runGit(args, {
      cwd: repoPath,
      env: { ...(await networkEnv(repoPath, opts.env)), ...LITERAL_PATHSPECS_ENV },
      timeoutMs: NETWORK_TIMEOUT,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (e) {
    if (e instanceof GitError && e.code === 'GIT_FAILED') {
      const d = e.detail ?? ''
      if (/terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey/i.test(d)) {
        throw new GitError('GIT_FAILED', 'Authentication failed. Configure an SSH key or a Git credential helper.', { detail: d })
      }
      if (/Host key verification failed/i.test(d)) {
        throw new GitError('GIT_FAILED', 'Host key verification failed. Connect once with ssh to trust the host.', { detail: d })
      }
      if (/transport 'file' not allowed/i.test(d)) {
        throw new GitError('GIT_FAILED', 'Cloning submodules from local paths is disabled (protocol.file.allow).', { detail: d })
      }
    }
    throw e
  }
}

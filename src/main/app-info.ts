import { app } from 'electron'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { getGitBinary } from '@git-core/runner'

const run = promisify(execFile)

/** `git version 2.54.0 …` from the given executable, or throws with a readable message. */
export async function gitVersion(binary: string = getGitBinary()): Promise<string> {
  try {
    const { stdout } = await run(binary, ['--version'], { timeout: 10_000, windowsHide: true })
    const m = /git version (\S+)/.exec(stdout)
    if (!m) throw new Error('not git')
    return m[1]!
  } catch {
    throw new Error(`"${binary}" is not a working Git executable.`)
  }
}

/** Validate a user-chosen git executable: absolute, a file, and answers `--version` like git. */
export async function validateGitPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Choose the full path of the Git program.')
  const s = await stat(path).catch(() => null)
  if (!s?.isFile()) throw new Error(`${path} is not a file.`)
  return gitVersion(path)
}

export async function appInfo(): Promise<{
  version: string
  platform: string
  home: string
  gitPath: string
  gitVersion: string | null
}> {
  return {
    version: app.getVersion(),
    platform: process.platform,
    home: homedir(),
    gitPath: getGitBinary(),
    gitVersion: await gitVersion().catch(() => null),
  }
}

const RELEASES_API = 'https://api.github.com/repos/szabto/gitbob/releases/latest'

/** Compare dotted versions numerically ("0.10.0" > "0.9.3"); pre-release suffixes sort lower. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): [number[], boolean] => {
    const [core = '', pre] = v.replace(/^v/i, '').split('-', 2)
    return [core.split('.').map((n) => Number(n) || 0), pre !== undefined]
  }
  const [a, aPre] = parse(latest)
  const [b, bPre] = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return !aPre && bPre
}

/** Ask GitHub Releases for the latest published GitBob version. Only called on request or opt-in. */
export async function checkForUpdate(): Promise<{ current: string; latest: string | null; newer: boolean; url: string | null }> {
  const current = app.getVersion()
  const res = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `GitBob/${current}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 404) return { current, latest: null, newer: false, url: null }
  if (!res.ok) throw new Error(`Could not check for updates (HTTP ${res.status}).`)
  const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
  const latest = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/i, '') : null
  const url = typeof data.html_url === 'string' && data.html_url.startsWith('https://github.com/') ? data.html_url : null
  return { current, latest, newer: !!latest && isNewer(latest, current), url }
}

/** Global git identity (used for commits). Empty strings when not set. */
export async function gitIdentity(): Promise<{ name: string; email: string }> {
  const get = async (key: string): Promise<string> => {
    try {
      const { stdout } = await run(getGitBinary(), ['config', '--global', '--get', key], { timeout: 10_000, windowsHide: true })
      return stdout.trim()
    } catch {
      return '' // exit code 1: not set
    }
  }
  const [name, email] = await Promise.all([get('user.name'), get('user.email')])
  return { name, email }
}

/** Set the global git identity, exactly like `git config --global user.name/email`. */
export async function setGitIdentity(name: string, email: string): Promise<void> {
  const clean = (v: string): string => v.trim()
  if (!clean(name) || /[\0\n\r]/.test(name) || !/^[^\s@]+@[^\s@]+$/.test(clean(email))) {
    throw new Error('Enter a name and a valid email address.')
  }
  await run(getGitBinary(), ['config', '--global', 'user.name', clean(name)], { timeout: 10_000, windowsHide: true })
  await run(getGitBinary(), ['config', '--global', 'user.email', clean(email)], { timeout: 10_000, windowsHide: true })
}

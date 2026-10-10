import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runGit } from './runner'

/**
 * Environment for network git commands (fetch, pull, push, clone, submodules, tags).
 *
 * ssh:
 *  - With the GitBob askpass bridge (extra.GIT_ASKPASS set, i.e. inside the app), ssh may
 *    prompt for key passphrases, passwords and new host keys through SSH_ASKPASS, so the
 *    user answers in a GitBob dialog.
 *  - Without it (CLI, tests), ssh runs with BatchMode=yes so it fails fast instead of
 *    waiting on a prompt nobody can see.
 *  - A user-configured ssh command (GIT_SSH_COMMAND, GIT_SSH, core.sshCommand) is never
 *    replaced; it still receives SSH_ASKPASS so it can prompt.
 *
 * Credentials: only when the user opted in (extra[USE_PLATFORM_HELPER] === '1', set by the app
 * after they chose "Remember" once) and has no git credential helper configured, GitBob's own
 * git calls use the platform's secure helper (macOS Keychain, Git Credential Manager,
 * libsecret) via environment-only config. The user's git configuration is never modified,
 * and the plaintext "store" helper is never chosen.
 */
export const USE_PLATFORM_HELPER = 'GITBOB_USE_PLATFORM_CREDENTIAL_HELPER'

export async function networkEnv(cwd: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const usePlatformHelper = extra[USE_PLATFORM_HELPER] === '1'
  const env: Record<string, string> = { ...extra }
  delete env[USE_PLATFORM_HELPER]
  const [sshCfg, helperCfg] = await Promise.all([
    runGit(['config', '--get', 'core.sshCommand'], { cwd, okExitCodes: [0, 1] }),
    runGit(['config', '--get-all', 'credential.helper'], { cwd, okExitCodes: [0, 1] }),
  ])

  const userSsh =
    !!process.env.GIT_SSH_COMMAND || !!process.env.GIT_SSH || !!extra.GIT_SSH_COMMAND || !!extra.GIT_SSH || !!sshCfg.stdout.trim()
  if (extra.GIT_ASKPASS) {
    env.SSH_ASKPASS = extra.GIT_ASKPASS
    env.SSH_ASKPASS_REQUIRE = 'force'
    // Older OpenSSH only consults SSH_ASKPASS when DISPLAY is set.
    if (!process.env.DISPLAY) env.DISPLAY = 'gitbob:0'
  } else if (!userSsh) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }

  if (usePlatformHelper && !helperCfg.stdout.trim()) {
    const helper = await platformCredentialHelper()
    if (helper) Object.assign(env, configEnv([['credential.helper', helper]], extra))
  }
  return env
}

/** Inject config through GIT_CONFIG_COUNT/KEY_n/VALUE_n, appending to any already present. */
function configEnv(pairs: [string, string][], existing: Record<string, string>): Record<string, string> {
  const start = Number(existing.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? 0) || 0
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length) }
  pairs.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = k
    out[`GIT_CONFIG_VALUE_${start + i}`] = v
  })
  return out
}

let cachedHelper: string | null | undefined

/** The OS-backed credential helper available to this git installation, if any. */
export async function platformCredentialHelper(): Promise<string | null> {
  if (cachedHelper !== undefined) return cachedHelper
  const candidates =
    process.platform === 'darwin'
      ? ['osxkeychain']
      : process.platform === 'win32'
        ? ['manager', 'manager-core', 'wincred']
        : ['libsecret']
  let execPath = ''
  try {
    execPath = (await runGit(['--exec-path'], { cwd: process.cwd() })).stdout.trim()
  } catch {
    cachedHelper = null
    return null
  }
  const ext = process.platform === 'win32' ? '.exe' : ''
  cachedHelper = candidates.find((c) => existsSync(join(execPath, `git-credential-${c}${ext}`))) ?? null
  return cachedHelper
}

export interface CredentialRecord {
  protocol: string
  host: string
  path?: string
  username: string
  password: string
}

/**
 * Hand credentials that just worked to git's credential helpers (`git credential approve`),
 * using the same helper selection as networkEnv. Returns false if no secure helper exists.
 */
export async function approveCredential(cwd: string, cred: CredentialRecord): Promise<boolean> {
  for (const v of Object.values(cred)) {
    if (typeof v === 'string' && /[\0\n]/.test(v)) return false
  }
  const env = await networkEnv(cwd, { [USE_PLATFORM_HELPER]: '1' })
  const configured = (await runGit(['config', '--get-all', 'credential.helper'], { cwd, okExitCodes: [0, 1] })).stdout.trim()
  if (!configured && !env.GIT_CONFIG_COUNT) return false
  const input =
    [
      `protocol=${cred.protocol}`,
      `host=${cred.host}`,
      ...(cred.path ? [`path=${cred.path}`] : []),
      `username=${cred.username}`,
      `password=${cred.password}`,
    ].join('\n') + '\n\n'
  await runGit(['credential', 'approve'], { cwd, env, input })
  return true
}

/** Parse git's credential prompts: "Username for 'https://host': " / "Password for 'https://user@host': ". */
export function parseCredentialPrompt(
  prompt: string,
): { field: 'username' | 'password'; protocol: string; host: string; username?: string } | null {
  const m = /^(Username|Password) for '([a-z][a-z0-9+.-]*):\/\/(?:([^@/']+)@)?([^/']+)[^']*'/i.exec(prompt)
  if (!m) return null
  return {
    field: m[1]!.toLowerCase() === 'username' ? 'username' : 'password',
    protocol: m[2]!.toLowerCase(),
    host: m[4]!,
    ...(m[3] ? { username: decodeURIComponent(m[3]) } : {}),
  }
}

import type { RemoteInfo } from '@shared/types'
import { GitError } from './errors'
import { runGit, type RunOptions } from './runner'
import { assertValidBranchName } from './branches'
import { parseProgress } from './askpass'
import { networkEnv } from './network-env'

const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function assertValidRemoteName(name: string): void {
  if (!REMOTE_NAME_RE.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new GitError('INVALID_ARGUMENT', `Invalid remote name: ${name}`)
  }
}

/** Network operations can take long and must never wait for interactive input. */
const NETWORK_TIMEOUT = 10 * 60_000

/** Options shared by all network operations. */
export interface NetworkOptions {
  signal?: AbortSignal
  /** Extra environment, e.g. the GIT_ASKPASS bridge. */
  env?: Record<string, string>
  /** Receives progress parsed from git's --progress output. */
  onProgress?: (p: { phase: string; percent: number }) => void
}


function networkError(e: unknown): never {
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
  }
  throw e
}

export async function listRemotes(repoPath: string): Promise<RemoteInfo[]> {
  const { stdout } = await runGit(['remote', '-v'], { cwd: repoPath })
  const map = new Map<string, RemoteInfo>()
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line)
    if (!m) continue
    const [, name = '', url = '', kind] = m
    const r = map.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (kind === 'fetch') r.fetchUrl = url
    else r.pushUrl = url
    map.set(name, r)
  }
  return [...map.values()]
}

export async function addRemote(repoPath: string, name: string, url: string): Promise<void> {
  assertValidRemoteName(name)
  if (!url || url.startsWith('-') || /[\s\0]/.test(url)) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid remote URL')
  }
  await runGit(['remote', 'add', '--', name, url], { cwd: repoPath })
}

export async function removeRemote(repoPath: string, name: string): Promise<void> {
  assertValidRemoteName(name)
  await runGit(['remote', 'remove', name], { cwd: repoPath })
}

export async function fetch(repoPath: string, opts: NetworkOptions & { remote?: string; prune: boolean }): Promise<void> {
  if (opts.remote) assertValidRemoteName(opts.remote)
  const args = ['fetch', progressFlag(opts), ...(opts.prune ? ['--prune'] : []), ...(opts.remote ? [opts.remote] : ['--all'])]
  await runGit(args, await run(repoPath, opts)).catch(networkError)
}

export type PullMode = 'ff-only' | 'merge' | 'rebase'

/** Pull the current branch from its upstream. */
export async function pull(repoPath: string, opts: NetworkOptions & { mode: PullMode }): Promise<void> {
  const modeArg = opts.mode === 'ff-only' ? '--ff-only' : opts.mode === 'rebase' ? '--rebase' : '--no-rebase'
  await runGit(['pull', progressFlag(opts), '--no-edit', modeArg], await run(repoPath, opts)).catch(
    (e: unknown) => {
      if (e instanceof GitError && /no tracking information|There is no tracking information/i.test(e.detail ?? '')) {
        throw new GitError('GIT_FAILED', 'The current branch has no upstream branch to pull from.', { detail: e.detail })
      }
      if (e instanceof GitError && /Not possible to fast-forward|not possible to fast-forward/i.test(e.detail ?? '')) {
        throw new GitError('GIT_FAILED', 'Cannot fast-forward: the branches have diverged. Pull with merge or rebase.', {
          detail: e.detail,
        })
      }
      networkError(e)
    },
  )
}

export async function push(
  repoPath: string,
  opts: NetworkOptions & { branch: string; remote: string; setUpstream: boolean; force: 'none' | 'with-lease' },
): Promise<void> {
  assertValidRemoteName(opts.remote)
  await assertValidBranchName(repoPath, opts.branch)
  const args = [
    'push',
    progressFlag(opts),
    ...(opts.setUpstream ? ['--set-upstream'] : []),
    ...(opts.force === 'with-lease' ? ['--force-with-lease'] : []),
    opts.remote,
    `refs/heads/${opts.branch}:refs/heads/${opts.branch}`,
  ]
  await runGit(args, await run(repoPath, opts)).catch((e: unknown) => {
    if (e instanceof GitError && /\[rejected\]|non-fast-forward|fetch first/i.test(`${e.detail ?? ''}`)) {
      throw new GitError('GIT_FAILED', 'Push rejected: the remote has changes you do not have. Pull first.', {
        detail: e.detail,
      })
    }
    networkError(e)
  })
}

function progressFlag(opts: NetworkOptions): string {
  return opts.onProgress ? '--progress' : '--no-progress'
}

async function run(cwd: string, opts: NetworkOptions): Promise<RunOptions> {
  const onProgress = opts.onProgress
  return {
    cwd,
    env: await networkEnv(cwd, opts.env),
    timeoutMs: NETWORK_TIMEOUT,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(onProgress
      ? {
          onStderr: (chunk: string) => {
            const p = parseProgress(chunk)
            if (p) onProgress(p)
          },
        }
      : {}),
  }
}

import { GitError } from './errors'
import { networkEnv } from './network-env'
import { assertValidRemoteName } from './remotes'
import { runGit } from './runner'

/**
 * Local copies of pull/merge request heads under `refs/gitbob/pr/<n>`, so a PR's commits can be
 * shown in the graph and diffed with the normal tools. These refs are private to GitBob: they
 * are not branches, are never pushed, and the graph only shows them when explicitly included.
 */

export const PR_REF_PREFIX = 'refs/gitbob/pr/'

/** GitHub (`refs/pull/<n>/head|merge`) and GitLab (`refs/merge-requests/<n>/head|merge`) PR refs. */
const PR_SOURCE_RE = /^refs\/(pull|merge-requests)\/[1-9]\d{0,9}\/(head|merge)$/
const NETWORK_TIMEOUT = 10 * 60_000

export interface PullRequestRef {
  number: number
  /** e.g. `refs/gitbob/pr/12` */
  ref: string
  sha: string
}

export interface FetchPullRequestOptions {
  signal?: AbortSignal
  /** Extra environment, e.g. the GIT_ASKPASS bridge (passed through networkEnv like fetch). */
  env?: Record<string, string>
}

function assertPrNumber(n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0) throw new GitError('INVALID_ARGUMENT', 'Invalid pull request number')
}

export function pullRequestRefName(n: number): string {
  assertPrNumber(n)
  return `${PR_REF_PREFIX}${n}`
}

/**
 * `git fetch --no-tags <remote> +<refspecSource>:refs/gitbob/pr/<n>`, then resolve the commit.
 * The local ref is force-updated, so a re-fetch follows force-pushes to the PR.
 */
export async function fetchPullRequestRef(
  repoPath: string,
  remote: string,
  refspecSource: string,
  number: number,
  opts: FetchPullRequestOptions = {},
): Promise<{ ref: string; sha: string }> {
  assertValidRemoteName(remote)
  if (typeof refspecSource !== 'string' || !PR_SOURCE_RE.test(refspecSource)) {
    throw new GitError('INVALID_ARGUMENT', `Invalid pull request ref: ${String(refspecSource)}`)
  }
  const ref = pullRequestRefName(number)
  await runGit(
    ['fetch', '--no-tags', '--no-progress', '--recurse-submodules=no', remote, `+${refspecSource}:${ref}`],
    {
      cwd: repoPath,
      env: await networkEnv(repoPath, opts.env),
      timeoutMs: NETWORK_TIMEOUT,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  ).catch((e: unknown) => {
    if (e instanceof GitError && e.code === 'GIT_FAILED') {
      const d = `${e.detail ?? ''}`
      if (/couldn't find remote ref|could not find remote ref/i.test(d)) {
        throw new GitError('NOT_FOUND', `The remote has no ${refspecSource}`, { detail: d })
      }
      if (/does not appear to be a git repository|No such remote/i.test(d)) {
        throw new GitError('NOT_FOUND', `Remote not found: ${remote}`, { detail: d })
      }
      if (/terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey/i.test(d)) {
        throw new GitError('GIT_FAILED', 'Authentication failed. Configure an SSH key or a Git credential helper.', {
          detail: d,
        })
      }
    }
    throw e
  })
  const r = await runGit(['rev-parse', '-q', '--verify', `${ref}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1] })
  const sha = r.stdout.trim()
  if (r.exitCode !== 0 || !sha) throw new GitError('INTERNAL', `Fetched ${refspecSource} but ${ref} is missing`)
  return { ref, sha }
}

/** Remove `refs/gitbob/pr/<n>`. Returns false if it did not exist. */
export async function deletePullRequestRef(repoPath: string, number: number): Promise<boolean> {
  const ref = pullRequestRefName(number)
  const r = await runGit(['rev-parse', '-q', '--verify', ref], { cwd: repoPath, okExitCodes: [0, 1] })
  if (r.exitCode !== 0) return false
  const old = r.stdout.trim()
  // Delete only the value we saw, so a concurrent re-fetch is not silently lost.
  await runGit(['update-ref', '-d', ref, old], { cwd: repoPath })
  return true
}

/** All local PR refs, ordered by number. */
export async function listPullRequestRefs(repoPath: string): Promise<PullRequestRef[]> {
  const r = await runGit(['for-each-ref', '--format=%(refname)%00%(objectname)', PR_REF_PREFIX], { cwd: repoPath })
  const out: PullRequestRef[] = []
  for (const line of r.stdout.split('\n')) {
    const [ref = '', sha = ''] = line.split('\0')
    const m = /^refs\/gitbob\/pr\/([1-9]\d*)$/.exec(ref)
    if (!m || !/^[0-9a-f]{40,64}$/.test(sha)) continue
    const n = Number(m[1])
    if (Number.isSafeInteger(n)) out.push({ number: n, ref, sha })
  }
  return out.sort((a, b) => a.number - b.number)
}

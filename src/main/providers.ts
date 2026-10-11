import type {
  CheckStatus,
  FileChange,
  HostedRepository,
  Issue,
  LineCommentInput,
  ProviderAccount,
  MergeMethod,
  ProviderKind,
  ProviderStatus,
  PullRequest,
  PullRequestComment,
  PullRequestDetail,
  RepoRef,
  ReviewEvent,
} from '@shared/types'
import { fetchPullRequestRef } from '@git-core/pr-refs'
import { fetch as gitFetch } from '@git-core/remotes'
import { getRangeFiles, mergeBase } from '@git-core/range'
import type { NetworkOptions } from '@git-core/remotes'
import { runGit } from '@git-core/runner'
import { listRemotes } from '@git-core/remotes'
import { GitError } from '@git-core/errors'
import { createAdapter, defaultApiBaseUrl, parseRemoteUrl, pollDeviceFlow, ProviderError, startDeviceFlow, type ProviderAdapter } from '../providers'
import type { TokenStore } from './tokens'

const tokenKey = (kind: ProviderKind, host: string): string => `${kind}:${host.toLowerCase()}`

/**
 * API base URL. Tests may point a provider at a local fake server with
 * GITBOB_TEST_PROVIDER_API_<KIND>=http://127.0.0.1:port (only loopback http is accepted by the client).
 */
function apiBase(ref: RepoRef): string {
  return process.env[`GITBOB_TEST_PROVIDER_API_${ref.kind.toUpperCase()}`] || defaultApiBaseUrl(ref)
}

/** Provider integration for opened repositories: detection, tokens, pull requests, CI status. */
export class ProviderService {
  private users = new Map<string, string>()
  private oauth: { repoPath: string; deviceCode: string; interval: number; expiresIn: number; controller: AbortController } | null = null

  /** @param githubClientId GitHub OAuth app client id for device-flow sign-in on a host (null disables it). */
  constructor(
    private readonly tokens: TokenStore,
    private readonly githubClientId: (host: string) => string | null = () => null,
  ) {}

  /** Start "Sign in with GitHub": returns the code the user enters at the verification page. */
  async startGitHubSignIn(repoPath: string): Promise<{ userCode: string; verificationUri: string }> {
    const found = await this.detect(repoPath)
    if (!found || found.ref.kind !== 'github') throw new GitError('INVALID_ARGUMENT', 'Sign-in is available for GitHub repositories.')
    const clientId = this.githubClientId(found.ref.host)
    if (!clientId) throw new GitError('INVALID_ARGUMENT', 'GitHub sign-in is not configured. Use a personal access token instead.')
    this.oauth?.controller.abort()
    const baseUrl = process.env.GITBOB_TEST_GITHUB_OAUTH || `https://${found.ref.host}`
    const flow = await mapErrors(() => startDeviceFlow({ clientId, scope: 'repo read:user', baseUrl }))
    this.oauth = { repoPath, deviceCode: flow.deviceCode, interval: flow.interval, expiresIn: flow.expiresIn, controller: new AbortController() }
    return { userCode: flow.userCode, verificationUri: flow.verificationUri }
  }

  /** Wait until the user approved in the browser, then store the token like a pasted one. */
  async finishGitHubSignIn(repoPath: string): Promise<{ user: string }> {
    const flow = this.oauth
    if (!flow || flow.repoPath !== repoPath) throw new GitError('INVALID_ARGUMENT', 'No GitHub sign-in in progress.')
    const found = (await this.detect(repoPath))!
    const clientId = this.githubClientId(found.ref.host)!
    try {
      const { accessToken } = await mapErrors(() =>
        pollDeviceFlow({
          clientId,
          deviceCode: flow.deviceCode,
          interval: flow.interval,
          expiresIn: flow.expiresIn,
          signal: flow.controller.signal,
          baseUrl: process.env.GITBOB_TEST_GITHUB_OAUTH || `https://${found.ref.host}`,
        }),
      )
      return await this.connect(repoPath, accessToken)
    } finally {
      if (this.oauth === flow) this.oauth = null
    }
  }

  cancelGitHubSignIn(): void {
    this.oauth?.controller.abort()
    this.oauth = null
  }

  /** First remote (origin preferred) that points at a recognized hosting service. */
  async detect(repoPath: string): Promise<{ ref: RepoRef; remote: string } | null> {
    const remotes = await listRemotes(repoPath)
    remotes.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0))
    for (const r of remotes) {
      const ref = parseRemoteUrl(r.fetchUrl) ?? parseRemoteUrl(r.pushUrl)
      if (ref) return { ref, remote: r.name }
    }
    return null
  }

  private adapterFor(ref: RepoRef, token: string): ProviderAdapter {
    return createAdapter(ref.kind, {
      token,
      baseUrl: apiBase(ref),
      ...(process.env.GITBOB_TEST_PROVIDER_PROFILE_AZURE ? { profileBaseUrl: process.env.GITBOB_TEST_PROVIDER_PROFILE_AZURE } : {}),
    })
  }

  private async connected(repoPath: string): Promise<{ ref: RepoRef; adapter: ProviderAdapter }> {
    const found = await this.detect(repoPath)
    if (!found) throw new GitError('NOT_FOUND', 'No GitHub, GitLab, Bitbucket or Azure DevOps remote in this repository.')
    const token = await this.tokens.get(tokenKey(found.ref.kind, found.ref.host))
    if (!token) throw new GitError('INVALID_ARGUMENT', `Not connected to ${found.ref.host}. Connect it in the sidebar first.`)
    return { ref: found.ref, adapter: this.adapterFor(found.ref, token) }
  }

  async status(repoPath: string): Promise<ProviderStatus> {
    const found = await this.detect(repoPath)
    const canStoreTokens = this.tokens.canStore()
    if (!found) return { repo: null, remote: null, connected: false, user: null, canStoreTokens, canSignIn: false }
    const key = tokenKey(found.ref.kind, found.ref.host)
    // Only checks that a token is saved: decrypting it would touch the OS keychain, which
    // must happen only when the token is actually used (listing pull requests, CI, …).
    const connected = await this.tokens.has(key)
    return {
      repo: found.ref,
      remote: found.remote,
      connected,
      user: connected ? (this.users.get(key) ?? null) : null,
      canStoreTokens,
      canSignIn: found.ref.kind === 'github' && !!this.githubClientId(found.ref.host),
    }
  }

  /** Verify a token against the provider, then store it encrypted. */
  async connect(repoPath: string, token: string): Promise<{ user: string }> {
    const found = await this.detect(repoPath)
    if (!found) throw new GitError('NOT_FOUND', 'No supported hosting remote in this repository.')
    const user = await mapErrors(() => this.adapterFor(found.ref, token).getUser())
    const key = tokenKey(found.ref.kind, found.ref.host)
    await this.tokens.set(key, token)
    this.users.set(key, user.login)
    return { user: user.login }
  }

  async disconnect(repoPath: string): Promise<void> {
    const found = await this.detect(repoPath)
    if (!found) return
    const key = tokenKey(found.ref.kind, found.ref.host)
    await this.tokens.delete(key)
    this.users.delete(key)
  }

  async pullRequests(repoPath: string, state: 'open' | 'all'): Promise<PullRequest[]> {
    const { ref, adapter } = await this.connected(repoPath)
    const key = tokenKey(ref.kind, ref.host)
    if (!this.users.has(key)) {
      // After a restart: learn who the stored token belongs to (best effort).
      const login = await adapter
        .getUser()
        .then((u) => u.login)
        .catch(() => null)
      if (login) this.users.set(key, login)
    }
    try {
      return await mapErrors(() => adapter.listPullRequests(ref, { state }))
    } catch (e) {
      // GitHub answers 404 (not 403) for repositories the token may not see, typically
      // organization repositories whose owners haven't approved the OAuth app.
      if (e instanceof GitError && e.code === 'NOT_FOUND' && ref.kind === 'github') {
        throw new GitError(
          'NOT_FOUND',
          `GitHub doesn't let this sign-in see ${ref.owner}/${ref.repo}. If it belongs to an organization, ask its owners to approve GitBob, or connect with an access token that includes this repository.`,
        )
      }
      throw e
    }
  }

  /** Open issues; null when the service (or this repository) has no issue tracker. */
  async issues(repoPath: string): Promise<Issue[] | null> {
    const { ref, adapter } = await this.connected(repoPath)
    if (!adapter.listIssues) return null
    try {
      return await mapErrors(() => adapter.listIssues!(ref))
    } catch (e) {
      // Bitbucket answers 404 when the repository's issue tracker is turned off.
      if (e instanceof GitError && e.code === 'NOT_FOUND' && ref.kind === 'bitbucket') return null
      throw e
    }
  }

  async checks(repoPath: string, sha: string): Promise<CheckStatus | null> {
    const found = await this.detect(repoPath)
    if (!found) return null
    const token = await this.tokens.get(tokenKey(found.ref.kind, found.ref.host))
    if (!token) return null
    return mapErrors(() => this.adapterFor(found.ref, token).getChecks(found.ref, sha))
  }

  async pullRequest(repoPath: string, number: number): Promise<PullRequestDetail> {
    const { ref, adapter } = await this.connected(repoPath)
    return mapErrors(() => adapter.getPullRequest(ref, number))
  }

  async comments(repoPath: string, number: number): Promise<PullRequestComment[]> {
    const { ref, adapter } = await this.connected(repoPath)
    return mapErrors(() => adapter.listComments(ref, number))
  }

  async addComment(repoPath: string, number: number, body: string): Promise<PullRequestComment> {
    const { ref, adapter } = await this.connected(repoPath)
    return mapErrors(() => adapter.addComment(ref, number, body))
  }

  async addLineComment(repoPath: string, number: number, input: LineCommentInput): Promise<PullRequestComment> {
    const { ref, adapter } = await this.connected(repoPath)
    return mapErrors(() => adapter.addLineComment(ref, number, input))
  }

  async review(repoPath: string, number: number, event: ReviewEvent, body: string): Promise<void> {
    const { ref, adapter } = await this.connected(repoPath)
    await mapErrors(() => adapter.submitReview(ref, number, event, body))
  }

  async merge(
    repoPath: string,
    number: number,
    opts: { method: MergeMethod; expectedHeadSha?: string; deleteSourceBranch: boolean },
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    const { ref, adapter } = await this.connected(repoPath)
    return mapErrors(() => adapter.mergePullRequest(ref, number, opts))
  }

  /**
   * Bring the pull request's commits into the local repository and list what it changes
   * (merge base of target and head → head), so the normal diff viewer can show them.
   */
  async changes(repoPath: string, number: number, net: NetworkOptions): Promise<PullRequestChanges> {
    const found = await this.detect(repoPath)
    if (!found) throw new GitError('NOT_FOUND', 'No supported hosting remote in this repository.')
    const { ref, adapter } = await this.connected(repoPath)
    const pr = await mapErrors(() => adapter.getPullRequest(ref, number))
    const remote = found.remote
    const refspec = adapter.pullRequestRefspec(ref, number)
    let head: string
    if (refspec) {
      head = (await fetchPullRequestRef(repoPath, remote, refspec, number, net)).sha
    } else {
      if (pr.headRepoIsFork) {
        throw new GitError('INVALID_ARGUMENT', 'This pull request comes from a fork, which GitBob cannot fetch for this provider yet.')
      }
      await gitFetch(repoPath, { ...net, remote, prune: false })
      head = await this.resolveRef(repoPath, `refs/remotes/${remote}/${pr.sourceBranch}`)
    }
    // Make sure the target branch is current, then diff from the merge base like the provider does.
    await gitFetch(repoPath, { ...net, remote, prune: false }).catch(() => {})
    const target = await this.resolveRef(repoPath, `refs/remotes/${remote}/${pr.targetBranch}`)
    const base = await mergeBase(repoPath, target, head)
    return { base, head, files: await getRangeFiles(repoPath, base, head) }
  }

  private async resolveRef(repoPath: string, refName: string): Promise<string> {
    const r = await runGit(['rev-parse', '-q', '--verify', `${refName}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1] })
    if (r.exitCode !== 0) throw new GitError('NOT_FOUND', `${refName.replace(/^refs\/remotes\//, '')} is not available locally; fetch first.`)
    return r.stdout.trim()
  }

  async createPullRequest(
    repoPath: string,
    input: { title: string; body: string; sourceBranch: string; targetBranch: string; draft: boolean },
  ): Promise<PullRequest> {
    const { ref, adapter } = await this.connected(repoPath)
    return mapErrors(() => adapter.createPullRequest(ref, input))
  }

  /** Hosting accounts with a saved token (no keychain access). */
  async accounts(): Promise<ProviderAccount[]> {
    const out: ProviderAccount[] = []
    for (const key of await this.tokens.keys()) {
      const m = /^(github|gitlab|bitbucket|azure):(.+)$/.exec(key)
      if (m) out.push({ kind: m[1] as ProviderKind, host: m[2]! })
    }
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.host.localeCompare(b.host))
  }

  /** Repositories the user of a connected account can clone, most recently updated first. */
  async hostedRepositories(kind: ProviderKind, host: string): Promise<HostedRepository[]> {
    const key = tokenKey(kind, host)
    if (!(await this.tokens.has(key))) throw new GitError('INVALID_ARGUMENT', `Not connected to ${host}.`)
    const token = await this.tokens.get(key)
    if (!token) throw new GitError('INVALID_ARGUMENT', `The saved token for ${host} could not be read. Connect it again.`)
    const ref: RepoRef = { kind, host, owner: '', repo: '', webUrl: `https://${host}` }
    return mapErrors(() => this.adapterFor(ref, token).listRepositories(host))
  }
}

export interface PullRequestChanges {
  base: string
  head: string
  files: FileChange[]
}

/** Provider errors become GitErrors (already token-redacted) so they cross IPC like the rest. */
async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ProviderError) {
      const code = e.code === 'NOT_FOUND' ? 'NOT_FOUND' : e.code === 'INVALID_ARGUMENT' ? 'INVALID_ARGUMENT' : 'GIT_FAILED'
      throw new GitError(code, e.message)
    }
    throw e
  }
}

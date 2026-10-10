import type { CheckStatus, ProviderKind, ProviderStatus, PullRequest, RepoRef } from '@shared/types'
import { listRemotes } from '@git-core/remotes'
import { GitError } from '@git-core/errors'
import { createAdapter, defaultApiBaseUrl, parseRemoteUrl, ProviderError, type ProviderAdapter } from '../providers'
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

  constructor(private readonly tokens: TokenStore) {}

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
    if (!found) return { repo: null, remote: null, connected: false, user: null, canStoreTokens }
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
    return mapErrors(() => adapter.listPullRequests(ref, { state }))
  }

  async checks(repoPath: string, sha: string): Promise<CheckStatus | null> {
    const found = await this.detect(repoPath)
    if (!found) return null
    const token = await this.tokens.get(tokenKey(found.ref.kind, found.ref.host))
    if (!token) return null
    return mapErrors(() => this.adapterFor(found.ref, token).getChecks(found.ref, sha))
  }

  async createPullRequest(
    repoPath: string,
    input: { title: string; body: string; sourceBranch: string; targetBranch: string; draft: boolean },
  ): Promise<PullRequest> {
    const { ref, adapter } = await this.connected(repoPath)
    return mapErrors(() => adapter.createPullRequest(ref, input))
  }
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

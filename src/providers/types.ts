import type { CheckStatus, ProviderKind, PullRequest, PullRequestState, RepoRef } from '@shared/types'
export type { CheckStatus, ProviderKind, PullRequest, PullRequestState, RepoRef }
/**
 * Plain-data types shared by the hosting-provider adapters (GitHub, GitLab, Bitbucket Cloud,
 * Azure DevOps). Everything here is serialisable so it can cross IPC unchanged, except
 * ProviderError which callers convert with `toJSON()`.
 */






export interface ProviderUser {
  login: string
  name: string | null
}

export interface ListPullRequestsOptions {
  state: 'open' | 'all'
  /** Maximum number of results (1..100, default 100). */
  limit?: number
}

export interface CreatePullRequestInput {
  title: string
  body: string
  sourceBranch: string
  targetBranch: string
  draft: boolean
}

export interface ProviderAdapter {
  readonly kind: ProviderKind
  getUser(): Promise<ProviderUser>
  listPullRequests(repo: RepoRef, opts: ListPullRequestsOptions): Promise<PullRequest[]>
  getChecks(repo: RepoRef, sha: string): Promise<CheckStatus>
  createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest>
  /** Browser URL that starts creating a pull request from `branch`. Pure; no network. */
  pullRequestUrlForBranch?(repo: RepoRef, branch: string): string
}

export interface AdapterOptions {
  /**
   * Personal access token. Bitbucket: `username:app-password` / `email:api-token` (Basic auth),
   * or a bare repository/workspace access token (Bearer).
   */
  token: string
  /** API base URL; override for GitHub Enterprise / self-hosted GitLab and for tests. */
  baseUrl?: string
  /** Azure DevOps only: base of the profile API used by getUser (default https://app.vssps.visualstudio.com). */
  profileBaseUrl?: string
  /** GitLab only: send the token as `PRIVATE-TOKEN` (default, PATs) or `Authorization: Bearer` (OAuth tokens). */
  authScheme?: 'private-token' | 'bearer'
  /** Per-request timeout in milliseconds (default 20000). */
  timeoutMs?: number
  /** Page size used for list requests (default: provider maximum). Mainly for tests. */
  pageSize?: number
  /** Cancels in-flight requests. */
  signal?: AbortSignal
}

export type ProviderErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'BAD_RESPONSE'
  | 'INVALID_ARGUMENT'

/** Error with a user-facing message. Messages are redacted and never contain the token. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  /** HTTP status, when the error came from a response. */
  readonly status: number | undefined
  /** Seconds until a rate limit resets, when the provider said so. */
  readonly retryAfterSeconds: number | undefined

  constructor(code: ProviderErrorCode, message: string, opts: { status?: number; retryAfterSeconds?: number } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = opts.status
    this.retryAfterSeconds = opts.retryAfterSeconds
  }

  toJSON(): { code: ProviderErrorCode; message: string; status?: number; retryAfterSeconds?: number } {
    return {
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
    }
  }
}

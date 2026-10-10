import { providerFetch, type ProviderFetchOptions, type ProviderResponse } from './client'
import type {
  AdapterOptions,
  CheckStatus,
  CreatePullRequestInput,
  ListPullRequestsOptions,
  ProviderAdapter,
  ProviderUser,
  PullRequest,
  RepoRef,
} from './types'
import {
  assertRepo,
  assertSha,
  clampLimit,
  expectArray,
  expectObject,
  num,
  obj,
  optStr,
  paginate,
  str,
  summarizeChecks,
  validateCreateInput,
  type CheckItem,
  type CheckItemState,
  safeWebUrl,
} from './util'

const LABEL = 'Bitbucket'
/** Bitbucket caps `pagelen` for pull requests at 50. */
const MAX_PAGELEN = 50

/**
 * Bitbucket Cloud REST 2.0.
 *
 * Token formats:
 * - `username:app-password` or `atlassian-email:api-token` → HTTP Basic (user-level credentials).
 * - a bare repository/project/workspace access token (no `:`) → Bearer. Such tokens are not
 *   tied to a user, so getUser() is expected to fail with them.
 */
export class BitbucketAdapter implements ProviderAdapter {
  readonly kind = 'bitbucket' as const
  private readonly baseUrl: string

  constructor(private readonly opts: AdapterOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.bitbucket.org/2.0'
  }

  private req<T>(path: string, extra: Partial<ProviderFetchOptions> = {}): Promise<ProviderResponse<T>> {
    return providerFetch<T>({
      baseUrl: this.baseUrl,
      path,
      token: this.opts.token,
      authScheme: this.opts.token.includes(':') ? 'basic' : 'bearer',
      label: LABEL,
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      ...extra,
    })
  }

  private repoPath(repo: RepoRef): string {
    assertRepo(repo, 'bitbucket')
    return `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
  }

  async getUser(): Promise<ProviderUser> {
    const { data } = await this.req('/user')
    const u = expectObject(data, LABEL)
    // `username` was removed for privacy; `nickname` is the public handle.
    return { login: str(u.nickname) || str(u.username) || str(u.account_id), name: optStr(u.display_name) }
  }

  async listPullRequests(repo: RepoRef, opts: ListPullRequestsOptions): Promise<PullRequest[]> {
    const base = this.repoPath(repo)
    const limit = clampLimit(opts.limit)
    const pagelen = Math.min(this.opts.pageSize ?? MAX_PAGELEN, MAX_PAGELEN, limit)
    const states = opts.state === 'all' ? ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] : ['OPEN']
    const first = `${base}/pullrequests?${states.map((s) => `state=${s}`).join('&')}&sort=-updated_on&pagelen=${pagelen}`
    return paginate(limit, async (cursor) => {
      const res = await this.req(cursor ?? first)
      const page = expectObject(res.data, LABEL)
      return { items: expectArray(page.values, LABEL).map(mapPull), next: optStr(page.next) }
    })
  }

  /** Build statuses reported for the commit (Bitbucket Pipelines and external CI). */
  async getChecks(repo: RepoRef, sha: string): Promise<CheckStatus> {
    const base = this.repoPath(repo)
    const commit = encodeURIComponent(assertSha(sha))
    const pagelen = Math.min(this.opts.pageSize ?? 100, 100)
    const items = await paginate(300, async (cursor) => {
      const res = await this.req(cursor ?? `${base}/commit/${commit}/statuses?pagelen=${pagelen}`)
      const page = expectObject(res.data, LABEL)
      return {
        items: expectArray(page.values, LABEL).map((s): CheckItem => {
          const o = obj(s)
          return { state: buildState(str(o.state)), url: optStr(o.url) }
        }),
        next: optStr(page.next),
      }
    })
    return summarizeChecks(items)
  }

  async createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest> {
    const base = this.repoPath(repo)
    const v = validateCreateInput(input)
    const { data } = await this.req(`${base}/pullrequests`, {
      method: 'POST',
      body: {
        title: v.title,
        description: v.body,
        source: { branch: { name: v.sourceBranch } },
        destination: { branch: { name: v.targetBranch } },
        draft: v.draft,
      },
    })
    return mapPull(data)
  }

  pullRequestUrlForBranch(repo: RepoRef, branch: string): string {
    return `${repo.webUrl}/pull-requests/new?source=${encodeURIComponent(branch)}&t=1`
  }
}

function mapPull(raw: unknown): PullRequest {
  const p = expectObject(raw, LABEL)
  const s = str(p.state)
  const state = s === 'OPEN' ? 'open' : s === 'MERGED' ? 'merged' : 'closed' // DECLINED, SUPERSEDED
  const author = obj(p.author)
  const id = num(p.id, LABEL)
  return {
    id,
    number: id,
    title: str(p.title),
    author: str(author.nickname) || str(author.display_name),
    state,
    draft: p.draft === true,
    sourceBranch: str(obj(obj(p.source).branch).name),
    targetBranch: str(obj(obj(p.destination).branch).name),
    url: safeWebUrl(str(obj(obj(p.links).html).href)) ?? '',
    createdAt: str(p.created_on),
    updatedAt: str(p.updated_on),
  }
}

/** SUCCESSFUL | FAILED | INPROGRESS | STOPPED */
function buildState(s: string): CheckItemState {
  if (s === 'SUCCESSFUL') return 'success'
  if (s === 'FAILED' || s === 'STOPPED') return 'failure'
  return 'pending'
}

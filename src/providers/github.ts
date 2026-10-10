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
  encodeBranchPath,
  expectArray,
  expectObject,
  num,
  obj,
  optStr,
  paginate,
  parseLinkNext,
  str,
  summarizeChecks,
  validateCreateInput,
  type CheckItem,
  type CheckItemState,
} from './util'

const LABEL = 'GitHub'

/** GitHub REST v3 (github.com or GitHub Enterprise Server via `baseUrl: https://host/api/v3`). */
export class GitHubAdapter implements ProviderAdapter {
  readonly kind = 'github' as const
  private readonly baseUrl: string

  constructor(private readonly opts: AdapterOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.github.com'
  }

  private req<T>(path: string, extra: Partial<ProviderFetchOptions> = {}): Promise<ProviderResponse<T>> {
    return providerFetch<T>({
      baseUrl: this.baseUrl,
      path,
      token: this.opts.token,
      authScheme: 'bearer',
      label: LABEL,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      ...extra,
    })
  }

  private repoPath(repo: RepoRef): string {
    assertRepo(repo, 'github')
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
  }

  async getUser(): Promise<ProviderUser> {
    const { data } = await this.req('/user')
    const u = expectObject(data, LABEL)
    return { login: str(u.login), name: optStr(u.name) }
  }

  async listPullRequests(repo: RepoRef, opts: ListPullRequestsOptions): Promise<PullRequest[]> {
    const base = this.repoPath(repo)
    const limit = clampLimit(opts.limit)
    const perPage = Math.min(this.opts.pageSize ?? 100, limit)
    const state = opts.state === 'all' ? 'all' : 'open'
    const first = `${base}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}`
    return paginate(limit, async (cursor) => {
      const res = await this.req(cursor ?? first)
      return {
        items: expectArray(res.data, LABEL).map(mapPull),
        next: parseLinkNext(res.headers.get('link')),
      }
    })
  }

  async getChecks(repo: RepoRef, sha: string): Promise<CheckStatus> {
    const base = this.repoPath(repo)
    const commit = encodeURIComponent(assertSha(sha))
    const perPage = Math.min(this.opts.pageSize ?? 100, 100)

    const statuses = paginate(300, async (cursor) => {
      const res = await this.req(cursor ?? `${base}/commits/${commit}/status?per_page=${perPage}`)
      const body = expectObject(res.data, LABEL)
      return {
        items: expectArray(body.statuses ?? [], LABEL).map((s): CheckItem => {
          const o = obj(s)
          return { state: statusState(str(o.state)), url: optStr(o.target_url) }
        }),
        next: parseLinkNext(res.headers.get('link')),
      }
    })
    const runs = paginate(300, async (cursor) => {
      const res = await this.req(cursor ?? `${base}/commits/${commit}/check-runs?per_page=${perPage}`)
      const body = expectObject(res.data, LABEL)
      return {
        items: expectArray(body.check_runs ?? [], LABEL).map((r): CheckItem => {
          const o = obj(r)
          return { state: checkRunState(str(o.status), optStr(o.conclusion)), url: optStr(o.html_url) }
        }),
        next: parseLinkNext(res.headers.get('link')),
      }
    })
    const [a, b] = await Promise.all([statuses, runs])
    return summarizeChecks([...a, ...b])
  }

  async createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest> {
    const base = this.repoPath(repo)
    const v = validateCreateInput(input)
    const { data } = await this.req(`${base}/pulls`, {
      method: 'POST',
      body: { title: v.title, body: v.body, head: v.sourceBranch, base: v.targetBranch, draft: v.draft },
    })
    return mapPull(data)
  }

  pullRequestUrlForBranch(repo: RepoRef, branch: string): string {
    return `${repo.webUrl}/pull/new/${encodeBranchPath(branch)}`
  }
}

function mapPull(raw: unknown): PullRequest {
  const p = expectObject(raw, LABEL)
  const state = optStr(p.merged_at) ? 'merged' : str(p.state) === 'open' ? 'open' : 'closed'
  return {
    id: num(p.id, LABEL),
    number: num(p.number, LABEL),
    title: str(p.title),
    author: str(obj(p.user).login),
    state,
    draft: p.draft === true,
    sourceBranch: str(obj(p.head).ref),
    targetBranch: str(obj(p.base).ref),
    url: str(p.html_url),
    createdAt: str(p.created_at),
    updatedAt: str(p.updated_at),
  }
}

/** Commit status API: error | failure | pending | success. */
function statusState(s: string): CheckItemState {
  if (s === 'success') return 'success'
  if (s === 'failure' || s === 'error') return 'failure'
  return 'pending'
}

/** Checks API: anything not completed is pending; completed runs map by conclusion. */
function checkRunState(status: string, conclusion: string | null): CheckItemState {
  if (status !== 'completed') return 'pending'
  switch (conclusion) {
    case 'success':
      return 'success'
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'startup_failure':
      return 'failure'
    case null:
      return 'pending'
    default:
      // neutral, skipped, stale
      return 'neutral'
  }
}

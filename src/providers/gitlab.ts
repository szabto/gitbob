import { providerFetch, type ProviderFetchOptions, type ProviderResponse } from './client'
import {
  ProviderError,
  type AdapterOptions,
  type CheckStatus,
  type CreatePullRequestInput,
  type ListPullRequestsOptions,
  type ProviderAdapter,
  type ProviderUser,
  type PullRequest,
  type RepoRef,
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
  parseLinkNext,
  str,
  summarizeChecks,
  validateCreateInput,
  type CheckItem,
  type CheckItemState,
} from './util'

const LABEL = 'GitLab'
/** GitLab's merge request title column limit. */
const GITLAB_MAX_TITLE = 255
const DRAFT_PREFIX_RE = /^\s*(\[draft\]|\(draft\)|draft:|draft\s*-)\s*/i

/** GitLab REST v4 (gitlab.com or self-managed via `baseUrl: https://host/api/v4`). */
export class GitLabAdapter implements ProviderAdapter {
  readonly kind = 'gitlab' as const
  private readonly baseUrl: string

  constructor(private readonly opts: AdapterOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://gitlab.com/api/v4'
  }

  private req<T>(path: string, extra: Partial<ProviderFetchOptions> = {}): Promise<ProviderResponse<T>> {
    return providerFetch<T>({
      baseUrl: this.baseUrl,
      path,
      token: this.opts.token,
      authScheme: this.opts.authScheme ?? 'private-token',
      label: LABEL,
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      ...extra,
    })
  }

  /** `/projects/group%2Fsub%2Frepo` */
  private projectPath(repo: RepoRef): string {
    assertRepo(repo, 'gitlab')
    return `/projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}`
  }

  async getUser(): Promise<ProviderUser> {
    const { data } = await this.req('/user')
    const u = expectObject(data, LABEL)
    return { login: str(u.username), name: optStr(u.name) }
  }

  async listPullRequests(repo: RepoRef, opts: ListPullRequestsOptions): Promise<PullRequest[]> {
    const base = this.projectPath(repo)
    const limit = clampLimit(opts.limit)
    const perPage = Math.min(this.opts.pageSize ?? 100, limit)
    const state = opts.state === 'all' ? 'all' : 'opened'
    const first = `${base}/merge_requests?state=${state}&order_by=updated_at&sort=desc&per_page=${perPage}`
    return paginate(limit, async (cursor) => {
      const res = await this.req(cursor ?? first)
      return { items: expectArray(res.data, LABEL).map(mapMergeRequest), next: parseLinkNext(res.headers.get('link')) }
    })
  }

  /** Latest commit statuses (CI jobs of all pipelines for the commit plus external statuses). */
  async getChecks(repo: RepoRef, sha: string): Promise<CheckStatus> {
    const base = this.projectPath(repo)
    const commit = encodeURIComponent(assertSha(sha))
    const perPage = Math.min(this.opts.pageSize ?? 100, 100)
    const items = await paginate(300, async (cursor) => {
      const res = await this.req(cursor ?? `${base}/repository/commits/${commit}/statuses?per_page=${perPage}`)
      return {
        items: expectArray(res.data, LABEL).map((s): CheckItem => {
          const o = obj(s)
          return { state: jobState(str(o.status), o.allow_failure === true), url: optStr(o.target_url) }
        }),
        next: parseLinkNext(res.headers.get('link')),
      }
    })
    return summarizeChecks(items)
  }

  async createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest> {
    const base = this.projectPath(repo)
    const v = validateCreateInput(input, 1_048_576)
    // GitLab marks drafts by title prefix; avoid doubling an existing prefix.
    const bare = v.title.replace(DRAFT_PREFIX_RE, '')
    const title = v.draft ? `Draft: ${bare || v.title}` : v.title
    if (title.length > GITLAB_MAX_TITLE) {
      throw new ProviderError('INVALID_ARGUMENT', `Title is longer than ${GITLAB_MAX_TITLE} characters.`)
    }
    const { data } = await this.req(`${base}/merge_requests`, {
      method: 'POST',
      body: { source_branch: v.sourceBranch, target_branch: v.targetBranch, title, description: v.body },
    })
    return mapMergeRequest(data)
  }

  pullRequestUrlForBranch(repo: RepoRef, branch: string): string {
    return `${repo.webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`
  }
}

function mapMergeRequest(raw: unknown): PullRequest {
  const m = expectObject(raw, LABEL)
  const s = str(m.state)
  // 'locked' is a transient state while a merge is in progress.
  const state = s === 'merged' ? 'merged' : s === 'opened' || s === 'locked' ? 'open' : 'closed'
  return {
    id: num(m.id, LABEL),
    number: num(m.iid, LABEL),
    title: str(m.title),
    author: str(obj(m.author).username),
    state,
    draft: m.draft === true || m.work_in_progress === true,
    sourceBranch: str(m.source_branch),
    targetBranch: str(m.target_branch),
    url: str(m.web_url),
    createdAt: str(m.created_at),
    updatedAt: str(m.updated_at),
  }
}

function jobState(status: string, allowFailure: boolean): CheckItemState {
  switch (status) {
    case 'success':
      return 'success'
    case 'failed':
      return allowFailure ? 'neutral' : 'failure'
    case 'canceled':
    case 'canceling':
      return 'failure'
    case 'skipped':
    case 'manual':
      return 'neutral'
    default:
      // created, waiting_for_resource, preparing, pending, running, scheduled
      return 'pending'
  }
}

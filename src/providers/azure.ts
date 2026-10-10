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
  stripHeads,
  summarizeChecks,
  validateCreateInput,
  type CheckItem,
  type CheckItemState,
} from './util'

const LABEL = 'Azure DevOps'
const API_VERSION = 'api-version=7.1'
/** Azure DevOps rejects pull request descriptions longer than this. */
const AZURE_MAX_DESCRIPTION = 4000

/**
 * Azure DevOps Services (dev.azure.com). Authenticates with a PAT over HTTP Basic with an empty
 * user name. Repository references come from parseRemoteUrl (owner = organization).
 */
export class AzureDevOpsAdapter implements ProviderAdapter {
  readonly kind = 'azure' as const
  private readonly baseUrl: string
  private readonly profileBaseUrl: string

  constructor(private readonly opts: AdapterOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://dev.azure.com'
    this.profileBaseUrl = opts.profileBaseUrl ?? 'https://app.vssps.visualstudio.com'
  }

  private req<T>(path: string, extra: Partial<ProviderFetchOptions> = {}): Promise<ProviderResponse<T>> {
    const token = this.opts.token.includes(':') ? this.opts.token : `:${this.opts.token}`
    return providerFetch<T>({
      baseUrl: this.baseUrl,
      path,
      token,
      authScheme: 'basic',
      label: LABEL,
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      ...extra,
    })
  }

  private repoPath(repo: RepoRef): string {
    assertRepo(repo, 'azure')
    const org = encodeURIComponent(repo.owner)
    const project = encodeURIComponent(repo.project!)
    return `/${org}/${project}/_apis/git/repositories/${encodeURIComponent(repo.repo)}`
  }

  /** Requires a PAT valid for "All accessible organizations" with the User Profile (read) scope. */
  async getUser(): Promise<ProviderUser> {
    const { data } = await this.req(`/_apis/profile/profiles/me?${API_VERSION}`, { baseUrl: this.profileBaseUrl })
    const u = expectObject(data, LABEL)
    return { login: str(u.emailAddress) || str(u.publicAlias) || str(u.id), name: optStr(u.displayName) }
  }

  async listPullRequests(repo: RepoRef, opts: ListPullRequestsOptions): Promise<PullRequest[]> {
    const base = this.repoPath(repo)
    const limit = clampLimit(opts.limit)
    const top = Math.min(this.opts.pageSize ?? 100, limit)
    const status = opts.state === 'all' ? 'all' : 'active'
    return paginate(limit, async (cursor) => {
      const skip = cursor ? Number(cursor) : 0
      const res = await this.req(
        `${base}/pullrequests?searchCriteria.status=${status}&$top=${top}&$skip=${skip}&${API_VERSION}`,
      )
      const items = expectArray(expectObject(res.data, LABEL).value, LABEL).map((p) => mapPull(p, repo))
      // Azure has no next link: a full page means there may be more.
      return { items, next: items.length === top ? String(skip + top) : null }
    })
  }

  /**
   * Latest commit statuses posted through the Git Status API. Azure Pipelines does not post
   * commit statuses by default, so builds without a status reporter are not included.
   */
  async getChecks(repo: RepoRef, sha: string): Promise<CheckStatus> {
    const base = this.repoPath(repo)
    const commit = encodeURIComponent(assertSha(sha))
    const top = Math.min(this.opts.pageSize ?? 100, 100)
    const items = await paginate(300, async (cursor) => {
      const skip = cursor ? Number(cursor) : 0
      const res = await this.req(`${base}/commits/${commit}/statuses?latestOnly=true&$top=${top}&$skip=${skip}&${API_VERSION}`)
      const list = expectArray(expectObject(res.data, LABEL).value, LABEL).map((s): CheckItem => {
        const o = obj(s)
        return { state: statusState(str(o.state)), url: optStr(o.targetUrl) }
      })
      return { items: list, next: list.length === top ? String(skip + top) : null }
    })
    return summarizeChecks(items)
  }

  async createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest> {
    const base = this.repoPath(repo)
    const v = validateCreateInput(input, AZURE_MAX_DESCRIPTION)
    const { data } = await this.req(`${base}/pullrequests?${API_VERSION}`, {
      method: 'POST',
      body: {
        sourceRefName: `refs/heads/${v.sourceBranch}`,
        targetRefName: `refs/heads/${v.targetBranch}`,
        title: v.title,
        description: v.body,
        isDraft: v.draft,
      },
    })
    return mapPull(data, repo)
  }

  pullRequestUrlForBranch(repo: RepoRef, branch: string): string {
    return `${repo.webUrl}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}`
  }
}

function mapPull(raw: unknown, repo: RepoRef): PullRequest {
  const p = expectObject(raw, LABEL)
  const s = str(p.status)
  const state = s === 'completed' ? 'merged' : s === 'abandoned' ? 'closed' : 'open'
  const id = num(p.pullRequestId, LABEL)
  const createdBy = obj(p.createdBy)
  const repoWeb = str(obj(p.repository).webUrl) || repo.webUrl
  const createdAt = str(p.creationDate)
  return {
    id,
    number: id,
    title: str(p.title),
    author: str(createdBy.uniqueName) || str(createdBy.displayName),
    state,
    draft: p.isDraft === true,
    sourceBranch: stripHeads(str(p.sourceRefName)),
    targetBranch: stripHeads(str(p.targetRefName)),
    url: `${repoWeb}/pullrequest/${id}`,
    createdAt,
    // Azure exposes no last-updated time; closedDate is the best available signal.
    updatedAt: str(p.closedDate) || createdAt,
  }
}

/** succeeded | failed | error | pending | notApplicable | notSet */
function statusState(s: string): CheckItemState {
  if (s === 'succeeded') return 'success'
  if (s === 'failed' || s === 'error') return 'failure'
  if (s === 'pending') return 'pending'
  return 'neutral'
}

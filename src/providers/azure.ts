import { providerFetch, type ProviderFetchOptions, type ProviderResponse } from './client'
import {
  ProviderError,
  type AdapterOptions,
  type CheckStatus,
  type CreatePullRequestInput,
  type ListPullRequestsOptions,
  type MergeMethod,
  type MergePullRequestOptions,
  type MergePullRequestResult,
  type MergeableState,
  type ProviderAdapter,
  type ProviderUser,
  type PullRequest,
  type PullRequestComment,
  type PullRequestDetail,
  type RepoRef,
  type ReviewEvent,
  type ReviewerState,
} from './types'
import {
  MERGE_METHODS,
  assertNumber,
  commitMessage,
  dedupeReviewers,
  providerDetail,
  recode,
  validateMergeOptions,
  validateReview,
  validateText,
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
  safeWebUrl,
} from './util'

const LABEL = 'Azure DevOps'
const API_VERSION = 'api-version=7.1'
/** Azure DevOps rejects pull request descriptions longer than this. */
const AZURE_MAX_DESCRIPTION = 4000
/** Azure DevOps comment content limit. */
const AZURE_MAX_COMMENT = 150_000

/** Reviewer votes. 'request-changes' casts -5 ("waiting for author"), not -10 ("rejected"). */
export const AZURE_VOTE = { approve: 10, approveWithSuggestions: 5, none: 0, waitingForAuthor: -5, rejected: -10 } as const

/**
 * Azure DevOps Services (dev.azure.com). Authenticates with a PAT over HTTP Basic with an empty
 * user name. Repository references come from parseRemoteUrl (owner = organization).
 */
export class AzureDevOpsAdapter implements ProviderAdapter {
  readonly kind = 'azure' as const
  private readonly baseUrl: string
  private readonly profileBaseUrl: string
  /** Authenticated identity id per organization (connectionData). */
  private readonly userIds = new Map<string, string>()

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

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestDetail> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const { data } = await this.req(`${base}/pullrequests/${id}?${API_VERSION}`)
    return mapPullDetail(data, repo)
  }

  /** Text comments of every thread (system and deleted comments skipped), oldest first. */
  async listComments(repo: RepoRef, number: number): Promise<PullRequestComment[]> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    // The threads API is not paged; it returns every thread of the pull request.
    const { data } = await this.req(`${base}/pullRequests/${id}/threads?${API_VERSION}`)
    const threads = expectArray(expectObject(data, LABEL).value, LABEL)
    const out: PullRequestComment[] = []
    for (const t of threads) out.push(...mapThread(t))
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async addComment(repo: RepoRef, number: number, body: string): Promise<PullRequestComment> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const text = validateText(body, { max: AZURE_MAX_COMMENT })
    const { data } = await this.req(`${base}/pullRequests/${id}/threads?${API_VERSION}`, {
      method: 'POST',
      body: { comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: 1 },
    })
    const c = mapThread(data)[0]
    if (!c) throw new ProviderError('BAD_RESPONSE', `${LABEL} returned an unexpected response.`)
    return c
  }

  /** Id of the identity behind the PAT in this organization (GET /{org}/_apis/connectionData). */
  private async currentUserId(repo: RepoRef): Promise<string> {
    const org = repo.owner
    const cached = this.userIds.get(org)
    if (cached) return cached
    const { data } = await this.req(`/${encodeURIComponent(org)}/_apis/connectionData`)
    const userId = str(obj(expectObject(data, LABEL).authenticatedUser).id)
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new ProviderError('BAD_RESPONSE', `${LABEL} did not return the signed-in user.`)
    this.userIds.set(org, userId)
    return userId
  }

  /**
   * approve → vote 10, request-changes → vote -5 ("waiting for author"), via
   * PUT /pullRequests/{id}/reviewers/{me}; comment (and any `body`) → a new comment thread.
   */
  async submitReview(repo: RepoRef, number: number, event: ReviewEvent, body: string): Promise<void> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const v = validateReview(event, body)
    if (v.event !== 'comment') {
      const me = await this.currentUserId(repo)
      const vote = v.event === 'approve' ? AZURE_VOTE.approve : AZURE_VOTE.waitingForAuthor
      await this.req(`${base}/pullRequests/${id}/reviewers/${encodeURIComponent(me)}?${API_VERSION}`, {
        method: 'PUT',
        body: { vote },
      })
    }
    if (v.body) {
      await this.req(`${base}/pullRequests/${id}/threads?${API_VERSION}`, {
        method: 'POST',
        body: { comments: [{ parentCommentId: 0, content: v.body, commentType: 1 }], status: 1 },
      })
    }
  }

  /**
   * PATCH status=completed with lastMergeSourceCommit (expectedHeadSha, else the current head)
   * and completionOptions.mergeStrategy noFastForward | squash | rebase. Azure completes
   * asynchronously and may wait on branch policies, so `merged` can be false on success.
   */
  async mergePullRequest(repo: RepoRef, number: number, opts: MergePullRequestOptions): Promise<MergePullRequestResult> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const v = validateMergeOptions(opts)
    let head = v.expectedHeadSha
    if (!head) {
      const pr = expectObject((await this.req(`${base}/pullrequests/${id}?${API_VERSION}`)).data, LABEL)
      head = optStr(obj(pr.lastMergeSourceCommit).commitId) ?? undefined
      if (!head) throw new ProviderError('BAD_RESPONSE', `${LABEL} did not report the pull request's source commit.`)
    }
    const msg = commitMessage(v.title, v.message)
    const mergeStrategy = v.method === 'merge' ? 'noFastForward' : v.method === 'squash' ? 'squash' : 'rebase'
    let data: unknown
    try {
      data = (
        await this.req(`${base}/pullrequests/${id}?${API_VERSION}`, {
          method: 'PATCH',
          body: {
            status: 'completed',
            lastMergeSourceCommit: { commitId: head },
            completionOptions: {
              mergeStrategy,
              deleteSourceBranch: v.deleteSourceBranch,
              ...(msg ? { mergeCommitMessage: msg } : {}),
            },
          },
        })
      ).data
    } catch (e) {
      if (e instanceof ProviderError && e.status === 409) {
        const d = providerDetail(e)
        throw recode(e, 'CONFLICT', `Pull request ${id} changed since it was reviewed, or cannot be completed${d ? `: ${d}` : '.'}`)
      }
      if (e instanceof ProviderError && e.status === 400) {
        const d = providerDetail(e)
        throw recode(e, 'CONFLICT', `Azure DevOps cannot complete pull request ${id}${d ? `: ${d}` : '.'}`)
      }
      throw e
    }
    const p = expectObject(data, LABEL)
    const status = str(p.status)
    const mergeStatus = str(p.mergeStatus)
    if (status === 'completed') {
      return { merged: true, sha: optStr(obj(p.lastMergeCommit).commitId), message: `Pull request ${id} completed.` }
    }
    if (mergeStatus === 'conflicts') {
      throw new ProviderError('CONFLICT', `Pull request ${id} has merge conflicts; resolve them before completing it.`)
    }
    if (mergeStatus === 'rejectedByPolicy') {
      throw new ProviderError('CONFLICT', `A branch policy blocks completing pull request ${id}.`)
    }
    return {
      merged: false,
      sha: null,
      message: `Azure DevOps is completing pull request ${id} (it may wait for branch policies); refresh in a moment.`,
    }
  }

  /**
   * Azure Repos publishes `refs/pull/{id}/merge` — the provider's test merge of the source into
   * the target, not the bare source head. Use the source branch when the head itself is needed.
   */
  pullRequestRefspec(repo: RepoRef, number: number): string {
    assertRepo(repo, 'azure')
    return `refs/pull/${assertNumber(number)}/merge`
  }
}

/** succeeded | conflicts | queued | notSet | rejectedByPolicy | failure */
function mergeableState(p: Record<string, unknown>): MergeableState {
  if (str(p.status) !== 'active' || p.isDraft === true) return 'no'
  switch (str(p.mergeStatus)) {
    case 'succeeded':
      return 'yes'
    case 'conflicts':
      return 'conflicts'
    case 'rejectedByPolicy':
    case 'failure':
      return 'no'
    default:
      return 'unknown'
  }
}

/** 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected. */
function voteState(vote: unknown): ReviewerState {
  if (typeof vote !== 'number' || vote === 0) return 'pending'
  return vote > 0 ? 'approved' : 'changes-requested'
}

function mapPullDetail(raw: unknown, repo: RepoRef): PullRequestDetail {
  const p = expectObject(raw, LABEL)
  const reviewers = (Array.isArray(p.reviewers) ? p.reviewers : []).map((r) => {
    const o = obj(r)
    return { login: str(o.uniqueName) || str(o.displayName), state: voteState(o.vote) }
  })
  return {
    ...mapPull(p, repo),
    body: str(p.description),
    baseSha: optStr(obj(p.lastMergeTargetCommit).commitId),
    headSha: optStr(obj(p.lastMergeSourceCommit).commitId),
    mergeable: mergeableState(p),
    // Branch policies may restrict strategies; the REST API does not expose that cheaply.
    mergeMethods: [...MERGE_METHODS] as MergeMethod[],
    reviewers: dedupeReviewers(reviewers),
    additions: null,
    deletions: null,
    changedFiles: null,
    headRepoIsFork: Object.keys(obj(p.forkSource)).length > 0,
  }
}

function mapThread(raw: unknown): PullRequestComment[] {
  const t = obj(raw)
  if (t.isDeleted === true) return []
  const ctx = obj(t.threadContext)
  const path = optStr(ctx.filePath)
  const right = obj(ctx.rightFileStart)
  const left = obj(ctx.leftFileStart)
  const line = typeof right.line === 'number' ? right.line : typeof left.line === 'number' ? left.line : undefined
  const out: PullRequestComment[] = []
  for (const c of Array.isArray(t.comments) ? t.comments : []) {
    const o = obj(c)
    if (o.isDeleted === true || o.commentType === 'system' || o.commentType === 3 || typeof o.id !== 'number') continue
    const author = obj(o.author)
    const comment: PullRequestComment = {
      id: `${String(t.id)}:${o.id}`,
      author: str(author.uniqueName) || str(author.displayName),
      body: str(o.content),
      createdAt: str(o.publishedDate),
    }
    if (path) comment.path = path
    if (path && line !== undefined) comment.line = line
    out.push(comment)
  }
  return out
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
    url: safeWebUrl(`${repoWeb}/pullrequest/${id}`) ?? '',
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

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
  type HostedRepository,
} from './types'
import {
  MERGE_METHODS,
  assertNumber,
  dedupeReviewers,
  isObject,
  optCount,
  providerDetail,
  recode,
  validateMergeOptions,
  validateReview,
  validateText,
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
  safeWebUrl,
  repoLimit,
  safeCloneUrl,
  safeSshUrl,
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

  async listRepositories(host: string, opts: { limit?: number } = {}): Promise<HostedRepository[]> {
    const limit = repoLimit(opts.limit)
    const perPage = Math.min(this.opts.pageSize ?? 100, 100)
    const first = `/user/repos?sort=updated&direction=desc&affiliation=owner,collaborator,organization_member&per_page=${perPage}`
    const repos = await paginate(limit, async (cursor) => {
      const res = await this.req(cursor ?? first)
      return { items: expectArray(res.data, LABEL), next: parseLinkNext(res.headers.get('link')) }
    })
    return repos.flatMap((r): HostedRepository[] => {
      const o = obj(r)
      const cloneUrl = safeCloneUrl(o.clone_url)
      if (!cloneUrl || !str(o.full_name)) return []
      return [{
        kind: 'github', host, fullName: str(o.full_name), description: optStr(o.description), private: o.private === true,
        cloneUrl, sshUrl: safeSshUrl(o.ssh_url), updatedAt: optStr(o.pushed_at) ?? optStr(o.updated_at),
      }]
    })
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

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestDetail> {
    const base = this.repoPath(repo)
    const n = assertNumber(number)
    const perPage = Math.min(this.opts.pageSize ?? 100, 100)
    const [pullRes, reviews, methods] = await Promise.all([
      this.req(`${base}/pulls/${n}`),
      paginate(300, async (cursor) => {
        const res = await this.req(cursor ?? `${base}/pulls/${n}/reviews?per_page=${perPage}`)
        return { items: expectArray(res.data, LABEL), next: parseLinkNext(res.headers.get('link')) }
      }),
      // allow_*_merge are only returned to users with push access; fall back to every method.
      this.req(base).then(
        (r) => allowedMethods(r.data),
        () => [...MERGE_METHODS],
      ),
    ])
    return mapPullDetail(pullRes.data, reviews, methods)
  }

  /** Conversation comments, inline review comments and review summaries, oldest first. */
  async listComments(repo: RepoRef, number: number): Promise<PullRequestComment[]> {
    const base = this.repoPath(repo)
    const n = assertNumber(number)
    const perPage = Math.min(this.opts.pageSize ?? 100, 100)
    const list = (first: string, map: (raw: unknown) => PullRequestComment | null): Promise<PullRequestComment[]> =>
      paginate(300, async (cursor) => {
        const res = await this.req(cursor ?? first)
        return { items: expectArray(res.data, LABEL), next: parseLinkNext(res.headers.get('link')) }
      }).then((raw) => raw.map(map).filter((c): c is PullRequestComment => c !== null))
    const [issue, inline, reviews] = await Promise.all([
      list(`${base}/issues/${n}/comments?per_page=${perPage}`, (r) => mapComment(r, 'issue')),
      list(`${base}/pulls/${n}/comments?per_page=${perPage}`, (r) => mapComment(r, 'review-comment')),
      list(`${base}/pulls/${n}/reviews?per_page=${perPage}`, mapReviewSummary),
    ])
    return [...issue, ...inline, ...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async addComment(repo: RepoRef, number: number, body: string): Promise<PullRequestComment> {
    const base = this.repoPath(repo)
    const n = assertNumber(number)
    const text = validateText(body)
    const { data } = await this.req(`${base}/issues/${n}/comments`, { method: 'POST', body: { body: text } })
    return mapComment(expectObject(data, LABEL), 'issue')!
  }

  async submitReview(repo: RepoRef, number: number, event: ReviewEvent, body: string): Promise<void> {
    const base = this.repoPath(repo)
    const n = assertNumber(number)
    const v = validateReview(event, body)
    const ghEvent = v.event === 'approve' ? 'APPROVE' : v.event === 'comment' ? 'COMMENT' : 'REQUEST_CHANGES'
    try {
      await this.req(`${base}/pulls/${n}/reviews`, {
        method: 'POST',
        body: { event: ghEvent, ...(v.body ? { body: v.body } : {}) },
      })
    } catch (e) {
      // GitHub answers 422 e.g. when approving or requesting changes on your own pull request.
      if (e instanceof ProviderError && e.status === 422) {
        throw recode(e, 'INVALID_ARGUMENT', `GitHub did not accept the review. ${providerDetail(e)}`.trim())
      }
      throw e
    }
  }

  /**
   * PUT /pulls/{n}/merge. `expectedHeadSha` is sent as `sha`, so GitHub refuses (409) when the
   * head moved. GitHub's merge endpoint cannot delete the branch; with `deleteSourceBranch` the
   * head branch is deleted afterwards when it lives in this repository (never for forks).
   */
  async mergePullRequest(repo: RepoRef, number: number, opts: MergePullRequestOptions): Promise<MergePullRequestResult> {
    const base = this.repoPath(repo)
    const n = assertNumber(number)
    const v = validateMergeOptions(opts)
    const pull = v.deleteSourceBranch ? expectObject((await this.req(`${base}/pulls/${n}`)).data, LABEL) : null
    let data: unknown
    try {
      data = (
        await this.req(`${base}/pulls/${n}/merge`, {
          method: 'PUT',
          body: {
            merge_method: v.method,
            ...(v.expectedHeadSha ? { sha: v.expectedHeadSha } : {}),
            ...(v.title && v.method !== 'rebase' ? { commit_title: v.title } : {}),
            ...(v.message && v.method !== 'rebase' ? { commit_message: v.message } : {}),
          },
        })
      ).data
    } catch (e) {
      if (e instanceof ProviderError && e.status === 409) {
        throw recode(e, 'CONFLICT', `Pull request #${n} changed since it was reviewed (new commits were pushed). Review it again before merging.`)
      }
      if (e instanceof ProviderError && e.status === 405) {
        const d = providerDetail(e)
        throw recode(e, 'CONFLICT', `GitHub cannot merge pull request #${n}${d ? `: ${d}` : ' (conflicts or a branch protection rule).'}`)
      }
      if (e instanceof ProviderError && e.status === 422) {
        const d = providerDetail(e)
        throw recode(e, 'INVALID_ARGUMENT', `GitHub rejected the merge request${d ? `: ${d}` : '.'}`)
      }
      throw e
    }
    const r = expectObject(data, LABEL)
    const merged = r.merged === true
    let message = str(r.message) || (merged ? 'Pull request merged.' : 'Pull request was not merged.')
    if (merged && pull) message += await this.deleteHeadBranch(repo, base, pull)
    return { merged, sha: optStr(r.sha), message }
  }

  private async deleteHeadBranch(repo: RepoRef, base: string, pull: Record<string, unknown>): Promise<string> {
    const head = obj(pull.head)
    const branch = str(head.ref)
    if (!branch || isForkHead(pull)) return ' The source branch is in a fork and was not deleted.'
    try {
      await this.req(`${base}/git/refs/heads/${encodeBranchPath(branch)}`, { method: 'DELETE' })
      return ` Deleted branch ${branch}.`
    } catch (e) {
      const why = e instanceof ProviderError ? e.message : 'unknown error'
      return ` The source branch ${branch} could not be deleted: ${why}`
    }
  }

  pullRequestRefspec(repo: RepoRef, number: number): string {
    assertRepo(repo, 'github')
    return `refs/pull/${assertNumber(number)}/head`
  }
}

function isForkHead(pull: Record<string, unknown>): boolean {
  const head = obj(obj(pull.head).repo)
  const baseRepo = obj(obj(pull.base).repo)
  // A deleted fork shows up as `head.repo: null`.
  if (!isObject(obj(pull.head).repo)) return true
  if (typeof head.id === 'number' && typeof baseRepo.id === 'number') return head.id !== baseRepo.id
  return str(head.full_name).toLowerCase() !== str(baseRepo.full_name).toLowerCase()
}

function allowedMethods(raw: unknown): MergeMethod[] {
  const r = obj(raw)
  const flags: [MergeMethod, unknown][] = [
    ['merge', r.allow_merge_commit],
    ['squash', r.allow_squash_merge],
    ['rebase', r.allow_rebase_merge],
  ]
  if (flags.every(([, f]) => typeof f !== 'boolean')) return [...MERGE_METHODS]
  return flags.filter(([, f]) => f === true).map(([m]) => m)
}

/** mergeable: true/false/null (still computing); mergeable_state refines why. */
function mergeableState(p: Record<string, unknown>): MergeableState {
  if (str(p.state) !== 'open' || optStr(p.merged_at)) return 'no'
  if (p.draft === true) return 'no'
  const ms = str(p.mergeable_state)
  if (p.mergeable === false) return ms === 'dirty' || ms === '' || ms === 'unknown' ? 'conflicts' : 'no'
  if (p.mergeable !== true) return 'unknown'
  if (ms === 'blocked' || ms === 'behind' || ms === 'draft') return 'no'
  if (ms === 'dirty') return 'conflicts'
  return 'yes' // clean, unstable (non-required checks failing), has_hooks, unknown
}

/** Latest review state per user; still-requested reviewers are pending. */
function reviewerList(p: Record<string, unknown>, reviews: unknown[]): PullRequestDetail['reviewers'] {
  const entries: { login: string; state: ReviewerState }[] = []
  const latest = new Map<string, ReviewerState>()
  for (const raw of reviews) {
    const r = obj(raw)
    const login = str(obj(r.user).login)
    if (!login) continue
    switch (str(r.state)) {
      case 'APPROVED':
        latest.set(login, 'approved')
        break
      case 'CHANGES_REQUESTED':
        latest.set(login, 'changes-requested')
        break
      case 'DISMISSED':
        latest.set(login, 'commented')
        break
      case 'COMMENTED':
        // A comment does not replace an earlier approval or change request.
        if (!latest.has(login)) latest.set(login, 'commented')
        break
      default:
        break // PENDING (unsubmitted drafts of the viewer)
    }
  }
  for (const [login, state] of latest) entries.push({ login, state })
  for (const u of Array.isArray(p.requested_reviewers) ? p.requested_reviewers : []) {
    const login = str(obj(u).login)
    if (login) entries.push({ login, state: 'pending' })
  }
  for (const t of Array.isArray(p.requested_teams) ? p.requested_teams : []) {
    const slug = str(obj(t).slug) || str(obj(t).name)
    if (slug) entries.push({ login: `team:${slug}`, state: 'pending' })
  }
  return dedupeReviewers(entries)
}

function mapPullDetail(raw: unknown, reviews: unknown[], mergeMethods: MergeMethod[]): PullRequestDetail {
  const p = expectObject(raw, LABEL)
  return {
    ...mapPull(p),
    body: str(p.body),
    baseSha: optStr(obj(p.base).sha),
    headSha: optStr(obj(p.head).sha),
    mergeable: mergeableState(p),
    mergeMethods,
    reviewers: reviewerList(p, reviews),
    additions: optCount(p.additions),
    deletions: optCount(p.deletions),
    changedFiles: optCount(p.changed_files),
    headRepoIsFork: isForkHead(p),
  }
}

function mapComment(raw: unknown, kind: 'issue' | 'review-comment'): PullRequestComment | null {
  const c = obj(raw)
  if (typeof c.id !== 'number' && typeof c.id !== 'string') return null
  const out: PullRequestComment = {
    id: `${kind}:${String(c.id)}`,
    author: str(obj(c.user).login),
    body: str(c.body),
    createdAt: str(c.created_at),
  }
  if (kind === 'review-comment') {
    const path = optStr(c.path)
    const line = typeof c.line === 'number' ? c.line : typeof c.original_line === 'number' ? c.original_line : undefined
    if (path) out.path = path
    if (line !== undefined) out.line = line
  }
  return out
}

/** Submitted reviews that carry a summary text. */
function mapReviewSummary(raw: unknown): PullRequestComment | null {
  const r = obj(raw)
  const body = str(r.body)
  if (!body.trim() || (typeof r.id !== 'number' && typeof r.id !== 'string') || str(r.state) === 'PENDING') return null
  return { id: `review:${String(r.id)}`, author: str(obj(r.user).login), body, createdAt: str(r.submitted_at) }
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
    url: safeWebUrl(str(p.html_url)) ?? '',
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

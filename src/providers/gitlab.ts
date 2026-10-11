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
  type LineCommentInput,
} from './types'
import {
  MERGE_METHODS,
  assertNumber,
  commitMessage,
  dedupeReviewers,
  optCount,
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
  validateLineComment,
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

  async listRepositories(host: string, opts: { limit?: number } = {}): Promise<HostedRepository[]> {
    const limit = repoLimit(opts.limit)
    const perPage = Math.min(this.opts.pageSize ?? 100, 100)
    const first = `/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&per_page=${perPage}`
    const repos = await paginate(limit, async (cursor) => {
      const res = await this.req(cursor ?? first)
      return { items: expectArray(res.data, LABEL), next: parseLinkNext(res.headers.get('link')) }
    })
    return repos.flatMap((r): HostedRepository[] => {
      const o = obj(r)
      const cloneUrl = safeCloneUrl(o.http_url_to_repo)
      if (!cloneUrl || !str(o.path_with_namespace)) return []
      return [{
        kind: 'gitlab', host, fullName: str(o.path_with_namespace), description: optStr(o.description),
        private: str(o.visibility, 'private') !== 'public',
        cloneUrl, sshUrl: safeSshUrl(o.ssh_url_to_repo), updatedAt: optStr(o.last_activity_at),
      }]
    })
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

  /** Merge methods allowed by the project's merge method and squash option (all, if unreadable). */
  private async projectMergeMethods(base: string): Promise<MergeMethod[]> {
    let project: Record<string, unknown>
    try {
      project = obj((await this.req(base)).data)
    } catch {
      return [...MERGE_METHODS]
    }
    return allowedMethods(project)
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestDetail> {
    const base = this.projectPath(repo)
    const iid = assertNumber(number)
    const [mrRes, approvals, methods] = await Promise.all([
      this.req(`${base}/merge_requests/${iid}`),
      // Approvals are available on every tier; tolerate instances where the endpoint is disabled.
      this.req(`${base}/merge_requests/${iid}/approvals`).then(
        (r) => obj(r.data),
        () => ({}) as Record<string, unknown>,
      ),
      this.projectMergeMethods(base),
    ])
    return mapMergeRequestDetail(mrRes.data, approvals, methods)
  }

  /** User notes (system notes such as "added 1 commit" are skipped), oldest first. */
  async listComments(repo: RepoRef, number: number): Promise<PullRequestComment[]> {
    const base = this.projectPath(repo)
    const iid = assertNumber(number)
    const perPage = Math.min(this.opts.pageSize ?? 100, 100)
    const first = `${base}/merge_requests/${iid}/notes?sort=asc&order_by=created_at&per_page=${perPage}`
    const raw = await paginate(300, async (cursor) => {
      const res = await this.req(cursor ?? first)
      return { items: expectArray(res.data, LABEL), next: parseLinkNext(res.headers.get('link')) }
    })
    return raw.map(mapNote).filter((c): c is PullRequestComment => c !== null)
  }

  async addComment(repo: RepoRef, number: number, body: string): Promise<PullRequestComment> {
    const base = this.projectPath(repo)
    const iid = assertNumber(number)
    const text = validateText(body, { max: 1_000_000 })
    const { data } = await this.req(`${base}/merge_requests/${iid}/notes`, { method: 'POST', body: { body: text } })
    const c = mapNote(data)
    if (!c) throw new ProviderError('BAD_RESPONSE', `${LABEL} returned an unexpected response.`)
    return c
  }

  /** A diff discussion positioned with the merge request's current diff_refs. */
  async addLineComment(repo: RepoRef, number: number, input: LineCommentInput): Promise<PullRequestComment> {
    const base = this.projectPath(repo)
    const iid = assertNumber(number)
    const v = validateLineComment(input, 1_000_000)
    const mr = expectObject((await this.req(`${base}/merge_requests/${iid}`)).data, LABEL)
    const refs = obj(mr.diff_refs)
    const head = str(refs.head_sha)
    if (!head || !str(refs.base_sha) || !str(refs.start_sha)) throw new ProviderError('BAD_RESPONSE', `${LABEL} returned an unexpected response.`)
    if (head.toLowerCase() !== v.headSha.toLowerCase()) {
      throw new ProviderError('CONFLICT', 'The merge request has new commits. Reload it before commenting on lines.')
    }
    const position = {
      position_type: 'text',
      base_sha: str(refs.base_sha),
      start_sha: str(refs.start_sha),
      head_sha: head,
      old_path: v.oldPath ?? v.path,
      new_path: v.path,
      ...(v.side === 'old' ? { old_line: v.line } : { new_line: v.line }),
    }
    const { data } = await this.req(`${base}/merge_requests/${iid}/discussions`, { method: 'POST', body: { body: v.body, position } })
    const note = Array.isArray(obj(data).notes) ? (obj(data).notes as unknown[])[0] : undefined
    const c = mapNote(note)
    if (!c) throw new ProviderError('BAD_RESPONSE', `${LABEL} returned an unexpected response.`)
    return c
  }

  /**
   * - approve: POST /approve (plus a note when `body` is given).
   * - comment: a note.
   * - request-changes: GitLab's REST API has no "request changes" review. The user's approval is
   *   withdrawn (POST /unapprove; ignored when they had not approved) and `body` is posted as a note.
   */
  async submitReview(repo: RepoRef, number: number, event: ReviewEvent, body: string): Promise<void> {
    const base = this.projectPath(repo)
    const iid = assertNumber(number)
    const v = validateReview(event, body)
    const mrPath = `${base}/merge_requests/${iid}`
    if (v.event === 'approve') {
      try {
        await this.req(`${mrPath}/approve`, { method: 'POST' })
      } catch (e) {
        // 401 here means "you cannot approve" (already approved / own MR / not eligible), not a bad token.
        if (e instanceof ProviderError && (e.status === 401 || e.status === 405)) {
          throw recode(e, 'FORBIDDEN', 'GitLab did not let you approve this merge request (already approved, or not an eligible approver).')
        }
        throw e
      }
    } else if (v.event === 'request-changes') {
      try {
        await this.req(`${mrPath}/unapprove`, { method: 'POST' })
      } catch (e) {
        if (!(e instanceof ProviderError && (e.status === 404 || e.status === 401))) throw e
      }
    }
    if (v.body) await this.req(`${mrPath}/notes`, { method: 'POST', body: { body: v.body } })
  }

  /**
   * PUT /merge_requests/{iid}/merge. 'squash' sets `squash: true`; 'rebase' is only accepted when
   * the project merges by fast-forward ("ff"), and 'merge' only when it does not, because GitLab
   * always applies the project's merge method. `expectedHeadSha` is sent as `sha` (409 on mismatch).
   */
  async mergePullRequest(repo: RepoRef, number: number, opts: MergePullRequestOptions): Promise<MergePullRequestResult> {
    const base = this.projectPath(repo)
    const iid = assertNumber(number)
    const v = validateMergeOptions(opts)
    const project = obj((await this.req(base)).data)
    const allowed = allowedMethods(project)
    if (!allowed.includes(v.method)) {
      throw new ProviderError(
        'INVALID_ARGUMENT',
        `This GitLab project does not allow "${v.method}" (merge method: ${str(project.merge_method) || 'unknown'}, squash: ${str(project.squash_option) || 'unknown'}). Allowed: ${allowed.join(', ') || 'none'}.`,
      )
    }
    const msg = commitMessage(v.title, v.message)
    const squash = v.method === 'squash'
    let data: unknown
    try {
      data = (
        await this.req(`${base}/merge_requests/${iid}/merge`, {
          method: 'PUT',
          body: {
            squash,
            ...(v.expectedHeadSha ? { sha: v.expectedHeadSha } : {}),
            ...(v.deleteSourceBranch ? { should_remove_source_branch: true } : {}),
            ...(msg && squash ? { squash_commit_message: msg } : {}),
            ...(msg && !squash && v.method === 'merge' ? { merge_commit_message: msg } : {}),
          },
        })
      ).data
    } catch (e) {
      if (e instanceof ProviderError && e.status === 409) {
        throw recode(e, 'CONFLICT', `Merge request !${iid} changed since it was reviewed (new commits were pushed). Review it again before merging.`)
      }
      if (e instanceof ProviderError && (e.status === 405 || e.status === 406 || e.status === 422)) {
        const d = providerDetail(e)
        throw recode(e, 'CONFLICT', `GitLab cannot merge merge request !${iid}${d ? `: ${d}` : ' (conflicts, draft, or unmet merge checks).'}`)
      }
      throw e
    }
    const m = expectObject(data, LABEL)
    const merged = str(m.state) === 'merged'
    const sha = optStr(m.merge_commit_sha) ?? optStr(m.squash_commit_sha) ?? (merged ? optStr(m.sha) : null)
    return {
      merged,
      sha,
      message: merged ? `Merge request !${iid} merged.` : `GitLab accepted the merge of !${iid}; it is still in progress.`,
    }
  }

  pullRequestRefspec(repo: RepoRef, number: number): string {
    assertRepo(repo, 'gitlab')
    return `refs/merge-requests/${assertNumber(number)}/head`
  }
}

/**
 * merge_method: merge | rebase_merge (merge commit, semi-linear) | ff (fast-forward, reported as
 * 'rebase'); squash_option: never | always | default_on | default_off.
 */
function allowedMethods(project: Record<string, unknown>): MergeMethod[] {
  const mm = str(project.merge_method)
  const sq = str(project.squash_option)
  if (!mm) return [...MERGE_METHODS]
  const out: MergeMethod[] = []
  if (sq !== 'always') out.push(mm === 'ff' ? 'rebase' : 'merge')
  if (sq !== 'never') out.push('squash')
  return out
}

function mergeableState(m: Record<string, unknown>): MergeableState {
  if (str(m.state) !== 'opened') return 'no'
  if (m.has_conflicts === true) return 'conflicts'
  const d = str(m.detailed_merge_status)
  if (d) {
    if (d === 'mergeable') return 'yes'
    if (d === 'conflict') return 'conflicts'
    if (d === 'checking' || d === 'unchecked' || d === 'preparing' || d === 'approvals_syncing') return 'unknown'
    return 'no' // ci_must_pass, not_approved, draft_status, discussions_not_resolved, need_rebase, ...
  }
  switch (str(m.merge_status)) {
    case 'can_be_merged':
      return m.draft === true || m.work_in_progress === true ? 'no' : 'yes'
    case 'cannot_be_merged':
      return 'conflicts'
    case 'cannot_be_merged_recheck':
    case 'unchecked':
    case 'checking':
      return 'unknown'
    default:
      return 'unknown'
  }
}

function mapMergeRequestDetail(
  raw: unknown,
  approvals: Record<string, unknown>,
  mergeMethods: MergeMethod[],
): PullRequestDetail {
  const m = expectObject(raw, LABEL)
  const refs = obj(m.diff_refs)
  const reviewers: { login: string; state: ReviewerState }[] = []
  for (const u of Array.isArray(m.reviewers) ? m.reviewers : []) {
    const login = str(obj(u).username)
    if (login) reviewers.push({ login, state: 'pending' })
  }
  for (const a of Array.isArray(approvals.approved_by) ? approvals.approved_by : []) {
    const login = str(obj(obj(a).user).username)
    if (login) reviewers.push({ login, state: 'approved' })
  }
  const source = m.source_project_id
  const target = m.target_project_id
  return {
    ...mapMergeRequest(m),
    body: str(m.description),
    baseSha: optStr(refs.base_sha),
    headSha: optStr(refs.head_sha) ?? optStr(m.sha),
    mergeable: mergeableState(m),
    mergeMethods,
    reviewers: dedupeReviewers(reviewers),
    // Line counts need the (expensive) diffs endpoint; changes_count may be "1000+".
    additions: null,
    deletions: null,
    changedFiles: optCount(m.changes_count),
    headRepoIsFork: typeof source === 'number' && typeof target === 'number' && source !== target,
  }
}

function mapNote(raw: unknown): PullRequestComment | null {
  const n = obj(raw)
  if (n.system === true || (typeof n.id !== 'number' && typeof n.id !== 'string')) return null
  const out: PullRequestComment = {
    id: String(n.id),
    author: str(obj(n.author).username),
    body: str(n.body),
    createdAt: str(n.created_at),
  }
  const pos = obj(n.position)
  const path = optStr(pos.new_path) ?? optStr(pos.old_path)
  const line = typeof pos.new_line === 'number' ? pos.new_line : typeof pos.old_line === 'number' ? pos.old_line : undefined
  if (path) out.path = path
  if (line !== undefined) out.line = line
  if (typeof pos.new_line !== 'number' && typeof pos.old_line === 'number') out.side = 'old'
  return out
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
    url: safeWebUrl(str(m.web_url)) ?? '',
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

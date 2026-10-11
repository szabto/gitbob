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
  commitMessage,
  dedupeReviewers,
  providerDetail,
  recode,
  sameSha,
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
  summarizeChecks,
  validateCreateInput,
  type CheckItem,
  type CheckItemState,
  safeWebUrl,
  repoLimit,
  safeCloneUrl,
  safeSshUrl,
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

  async listRepositories(host: string, opts: { limit?: number } = {}): Promise<HostedRepository[]> {
    const limit = repoLimit(opts.limit)
    const perPage = Math.min(this.opts.pageSize ?? 100, 100)
    const repos = await paginate(limit, async (cursor) => {
      const res = await this.req(cursor ?? `/repositories?role=member&sort=-updated_on&pagelen=${perPage}`)
      const body = expectObject(res.data, LABEL)
      return { items: expectArray(body.values ?? [], LABEL), next: optStr(body.next) }
    })
    return repos.flatMap((r): HostedRepository[] => {
      const o = obj(r)
      const links = Array.isArray(obj(o.links).clone) ? (obj(o.links).clone as unknown[]).map(obj) : []
      const href = (name: string) => links.find((l) => l.name === name)?.href
      const cloneUrl = safeCloneUrl(href('https'))
      if (!cloneUrl || !str(o.full_name)) return []
      return [{
        kind: 'bitbucket', host, fullName: str(o.full_name), description: optStr(o.description), private: o.is_private !== false,
        cloneUrl, sshUrl: safeSshUrl(href('ssh')), updatedAt: optStr(o.updated_on),
      }]
    })
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

  /**
   * Bitbucket reports no mergeability flag; the diffstat marks conflicted files with
   * `status: "merge conflict"` and gives line counts. Merge checks (Premium) are not evaluated,
   * so 'yes' means "no conflicts" only. Hashes are the 12-character abbreviations Bitbucket returns.
   */
  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestDetail> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const pagelen = Math.min(this.opts.pageSize ?? 500, 500)
    const [prRes, diffstat] = await Promise.all([
      this.req(`${base}/pullrequests/${id}`),
      paginate(1500, async (cursor) => {
        const res = await this.req(cursor ?? `${base}/pullrequests/${id}/diffstat?pagelen=${pagelen}`)
        const page = expectObject(res.data, LABEL)
        return { items: expectArray(page.values, LABEL), next: optStr(page.next) }
      }).then(
        (items) => items,
        () => null,
      ),
    ])
    return mapPullDetail(prRes.data, diffstat)
  }

  /** General and inline comments (deleted ones skipped), oldest first. */
  async listComments(repo: RepoRef, number: number): Promise<PullRequestComment[]> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const pagelen = Math.min(this.opts.pageSize ?? 100, 100)
    const raw = await paginate(300, async (cursor) => {
      const res = await this.req(cursor ?? `${base}/pullrequests/${id}/comments?sort=created_on&pagelen=${pagelen}`)
      const page = expectObject(res.data, LABEL)
      return { items: expectArray(page.values, LABEL), next: optStr(page.next) }
    })
    return raw
      .map(mapComment)
      .filter((c): c is PullRequestComment => c !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async addComment(repo: RepoRef, number: number, body: string): Promise<PullRequestComment> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const text = validateText(body)
    const { data } = await this.req(`${base}/pullrequests/${id}/comments`, { method: 'POST', body: { content: { raw: text } } })
    const c = mapComment(data)
    if (!c) throw new ProviderError('BAD_RESPONSE', `${LABEL} returned an unexpected response.`)
    return c
  }

  /** approve → POST /approve, request-changes → POST /request-changes, comment → comment; `body` is added as a comment. */
  async submitReview(repo: RepoRef, number: number, event: ReviewEvent, body: string): Promise<void> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const v = validateReview(event, body)
    const prPath = `${base}/pullrequests/${id}`
    if (v.event !== 'comment') {
      try {
        await this.req(`${prPath}/${v.event === 'approve' ? 'approve' : 'request-changes'}`, { method: 'POST' })
      } catch (e) {
        // 400 e.g. "You can't approve your own pull request" / already approved.
        if (e instanceof ProviderError && (e.status === 400 || e.status === 409)) {
          throw recode(e, 'INVALID_ARGUMENT', `Bitbucket did not accept the review. ${providerDetail(e)}`.trim())
        }
        throw e
      }
    }
    if (v.body) await this.req(`${prPath}/comments`, { method: 'POST', body: { content: { raw: v.body } } })
  }

  /**
   * POST /pullrequests/{id}/merge with merge_strategy merge_commit | squash | fast_forward
   * ('rebase' uses rebase_fast_forward when the destination branch offers it). Bitbucket has no
   * head-SHA guard, so `expectedHeadSha` is checked against a fresh read of the pull request just
   * before merging (a push in between those two requests is not detected).
   */
  async mergePullRequest(repo: RepoRef, number: number, opts: MergePullRequestOptions): Promise<MergePullRequestResult> {
    const base = this.repoPath(repo)
    const id = assertNumber(number)
    const v = validateMergeOptions(opts)
    const pr = expectObject((await this.req(`${base}/pullrequests/${id}`)).data, LABEL)
    const head = optStr(obj(obj(pr.source).commit).hash)
    if (v.expectedHeadSha && (!head || !sameSha(head, v.expectedHeadSha))) {
      throw new ProviderError(
        'CONFLICT',
        `Pull request #${id} changed since it was reviewed (new commits were pushed). Review it again before merging.`,
      )
    }
    const offered = strategies(pr)
    const allowed = methodsFromStrategies(offered)
    if (!allowed.includes(v.method)) {
      throw new ProviderError('INVALID_ARGUMENT', `The destination branch does not allow "${v.method}". Allowed: ${allowed.join(', ') || 'none'}.`)
    }
    const strategy =
      v.method === 'merge'
        ? 'merge_commit'
        : v.method === 'squash'
          ? 'squash'
          : offered.includes('rebase_fast_forward') && !offered.includes('fast_forward')
            ? 'rebase_fast_forward'
            : 'fast_forward'
    const msg = commitMessage(v.title, v.message)
    let res: { status: number; data: unknown }
    try {
      res = await this.req(`${base}/pullrequests/${id}/merge`, {
        method: 'POST',
        body: {
          type: 'pullrequest_merge_parameters',
          merge_strategy: strategy,
          close_source_branch: v.deleteSourceBranch,
          ...(msg && strategy !== 'fast_forward' ? { message: msg } : {}),
        },
      })
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 400 || e.status === 409)) {
        const d = providerDetail(e)
        throw recode(e, 'CONFLICT', `Bitbucket cannot merge pull request #${id}${d ? `: ${d}` : ' (conflicts or unmet merge checks).'}`)
      }
      throw e
    }
    if (res.status === 202) {
      return { merged: false, sha: null, message: `Bitbucket is still merging pull request #${id}; refresh in a moment.` }
    }
    const m = expectObject(res.data, LABEL)
    const merged = str(m.state) === 'MERGED'
    return {
      merged,
      sha: optStr(obj(m.merge_commit).hash),
      message: merged ? `Pull request #${id} merged.` : `Pull request #${id} was not merged.`,
    }
  }

  /** Bitbucket Cloud does not expose pull request refs; fetch the source branch (from the fork, if any). */
  pullRequestRefspec(repo: RepoRef, number: number): null {
    assertRepo(repo, 'bitbucket')
    assertNumber(number)
    return null
  }
}

function strategies(pr: Record<string, unknown>): string[] {
  const list = obj(obj(pr.destination).branch).merge_strategies
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []
}

/** merge_commit → merge; squash / squash_fast_forward → squash; fast_forward / rebase_* → rebase. */
function methodsFromStrategies(list: string[]): MergeMethod[] {
  if (list.length === 0) return [...MERGE_METHODS]
  const out = new Set<MergeMethod>()
  for (const s of list) {
    if (s === 'merge_commit' || s === 'rebase_merge') out.add('merge')
    else if (s === 'squash' || s === 'squash_fast_forward') out.add('squash')
    else if (s === 'fast_forward' || s === 'rebase_fast_forward') out.add('rebase')
  }
  return MERGE_METHODS.filter((m) => out.has(m))
}

function login(user: unknown): string {
  const u = obj(user)
  return str(u.nickname) || str(u.display_name)
}

function mapPullDetail(raw: unknown, diffstat: unknown[] | null): PullRequestDetail {
  const p = expectObject(raw, LABEL)
  const pr = mapPull(p)
  const reviewers: { login: string; state: ReviewerState }[] = []
  for (const r of Array.isArray(p.reviewers) ? p.reviewers : []) {
    const l = login(r)
    if (l) reviewers.push({ login: l, state: 'pending' })
  }
  for (const raw of Array.isArray(p.participants) ? p.participants : []) {
    const part = obj(raw)
    const l = login(part.user)
    if (!l) continue
    const st = str(part.state)
    const state: ReviewerState =
      part.approved === true || st === 'approved'
        ? 'approved'
        : st === 'changes_requested'
          ? 'changes-requested'
          : str(part.role) === 'REVIEWER'
            ? 'pending'
            : 'commented'
    reviewers.push({ login: l, state })
  }
  let additions: number | null = null
  let deletions: number | null = null
  let changedFiles: number | null = null
  let conflicts = false
  if (diffstat) {
    additions = 0
    deletions = 0
    changedFiles = diffstat.length
    for (const d of diffstat) {
      const o = obj(d)
      additions += typeof o.lines_added === 'number' ? o.lines_added : 0
      deletions += typeof o.lines_removed === 'number' ? o.lines_removed : 0
      const st = str(o.status)
      if (st === 'merge conflict' || st === 'local deleted' || st === 'remote deleted') conflicts = true
    }
  }
  const mergeable: MergeableState =
    pr.state !== 'open' || pr.draft ? 'no' : conflicts ? 'conflicts' : diffstat ? 'yes' : 'unknown'
  const srcRepo = str(obj(obj(p.source).repository).full_name).toLowerCase()
  const dstRepo = str(obj(obj(p.destination).repository).full_name).toLowerCase()
  return {
    ...pr,
    body: str(p.description),
    baseSha: optStr(obj(obj(p.destination).commit).hash),
    headSha: optStr(obj(obj(p.source).commit).hash),
    mergeable,
    mergeMethods: methodsFromStrategies(strategies(p)),
    reviewers: dedupeReviewers(reviewers),
    additions,
    deletions,
    changedFiles,
    headRepoIsFork: !!srcRepo && !!dstRepo && srcRepo !== dstRepo,
  }
}

function mapComment(raw: unknown): PullRequestComment | null {
  const c = obj(raw)
  if (c.deleted === true || typeof c.id !== 'number') return null
  const out: PullRequestComment = {
    id: String(c.id),
    author: login(c.user),
    body: str(obj(c.content).raw),
    createdAt: str(c.created_on),
  }
  const inline = obj(c.inline)
  const path = optStr(inline.path)
  const line = typeof inline.to === 'number' ? inline.to : typeof inline.from === 'number' ? inline.from : undefined
  if (path) out.path = path
  if (line !== undefined) out.line = line
  return out
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

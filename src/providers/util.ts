import {
  ProviderError,
  type CheckStatus,
  type CreatePullRequestInput,
  type MergeMethod,
  type MergePullRequestOptions,
  type ProviderKind,
  type PullRequestReviewer,
  type RepoRef,
  type ReviewEvent,
  type ReviewerState,
  type LineCommentInput,
} from './types'

// ---------------------------------------------------------------------------
// Input validation

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\0-\x1f\x7f]/
export const MAX_TITLE = 256
export const MAX_BODY = 65_536
const SHA_RE = /^[0-9a-f]{7,64}$/i

export function assertRepo(repo: RepoRef, kind: ProviderKind): void {
  if (!repo || repo.kind !== kind) {
    throw new ProviderError('INVALID_ARGUMENT', `Repository is not a ${kind} repository.`)
  }
  if (!repo.owner || !repo.repo || CONTROL_RE.test(repo.owner) || CONTROL_RE.test(repo.repo)) {
    throw new ProviderError('INVALID_ARGUMENT', 'Repository owner and name are required.')
  }
  if (kind === 'azure' && (!repo.project || CONTROL_RE.test(repo.project))) {
    throw new ProviderError('INVALID_ARGUMENT', 'Azure DevOps repositories need a project.')
  }
}

/** Branch names: non-empty, no control characters or newlines, `refs/heads/` stripped. */
export function normalizeBranch(name: string, what: string): string {
  const b = typeof name === 'string' ? name.trim().replace(/^refs\/heads\//, '') : ''
  if (!b || CONTROL_RE.test(b) || b.length > 255 || b.startsWith('-') || /\s/.test(b)) {
    throw new ProviderError('INVALID_ARGUMENT', `Invalid ${what} branch name.`)
  }
  return b
}

export function assertSha(sha: string): string {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new ProviderError('INVALID_ARGUMENT', 'Invalid commit SHA.')
  return sha.toLowerCase()
}

export interface ValidatedPullRequestInput extends CreatePullRequestInput {
  /** Trimmed title. */
  title: string
}

export function validateCreateInput(input: CreatePullRequestInput, maxBody = MAX_BODY): ValidatedPullRequestInput {
  const title = typeof input?.title === 'string' ? input.title.trim() : ''
  if (!title) throw new ProviderError('INVALID_ARGUMENT', 'Title is required.')
  if (title.length > MAX_TITLE) throw new ProviderError('INVALID_ARGUMENT', `Title is longer than ${MAX_TITLE} characters.`)
  if (/[\r\n]/.test(title) || CONTROL_RE.test(title)) {
    throw new ProviderError('INVALID_ARGUMENT', 'Title must be a single line.')
  }
  const body = typeof input.body === 'string' ? input.body : ''
  if (body.length > maxBody) throw new ProviderError('INVALID_ARGUMENT', `Description is longer than ${maxBody} characters.`)
  const sourceBranch = normalizeBranch(input.sourceBranch, 'source')
  const targetBranch = normalizeBranch(input.targetBranch, 'target')
  if (sourceBranch === targetBranch) {
    throw new ProviderError('INVALID_ARGUMENT', 'Source and target branch must differ.')
  }
  return { title, body, sourceBranch, targetBranch, draft: input.draft === true }
}

/** Pull/merge request numbers: positive safe integers. */
export function assertNumber(n: number): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new ProviderError('INVALID_ARGUMENT', 'Invalid pull request number.')
  }
  return n
}

/** Comment / review text: at most `max` characters; non-blank unless `allowEmpty`. */
export function validateText(body: string, opts: { allowEmpty?: boolean; max?: number; what?: string } = {}): string {
  const max = opts.max ?? MAX_BODY
  const what = opts.what ?? 'Comment'
  if (typeof body !== 'string') {
    if (opts.allowEmpty && (body === undefined || body === null)) return ''
    throw new ProviderError('INVALID_ARGUMENT', `${what} must be text.`)
  }
  if (body.length > max) throw new ProviderError('INVALID_ARGUMENT', `${what} is longer than ${max} characters.`)
  if (body.includes('\0')) throw new ProviderError('INVALID_ARGUMENT', `${what} contains invalid characters.`)
  if (!opts.allowEmpty && !body.trim()) throw new ProviderError('INVALID_ARGUMENT', `${what} is required.`)
  return body
}

export const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase']
const REVIEW_EVENTS: readonly ReviewEvent[] = ['approve', 'comment', 'request-changes']

/** Review event plus its text; comment and request-changes need a non-blank body. */
export function validateReview(event: ReviewEvent, body: string): { event: ReviewEvent; body: string } {
  if (!REVIEW_EVENTS.includes(event)) throw new ProviderError('INVALID_ARGUMENT', 'Invalid review action.')
  const text = validateText(body, { allowEmpty: event === 'approve', what: 'Review comment' })
  return { event, body: text }
}

export interface ValidatedMergeOptions {
  method: MergeMethod
  title: string | undefined
  message: string | undefined
  expectedHeadSha: string | undefined
  deleteSourceBranch: boolean
}

export function validateMergeOptions(opts: MergePullRequestOptions): ValidatedMergeOptions {
  if (!opts || !MERGE_METHODS.includes(opts.method)) throw new ProviderError('INVALID_ARGUMENT', 'Invalid merge method.')
  let title: string | undefined
  if (opts.title !== undefined && opts.title !== null) {
    if (typeof opts.title !== 'string') throw new ProviderError('INVALID_ARGUMENT', 'Merge commit title must be text.')
    title = opts.title.trim() || undefined
    if (title && title.length > MAX_TITLE) {
      throw new ProviderError('INVALID_ARGUMENT', `Merge commit title is longer than ${MAX_TITLE} characters.`)
    }
    if (title && CONTROL_RE.test(title)) throw new ProviderError('INVALID_ARGUMENT', 'Merge commit title must be a single line.')
  }
  let message: string | undefined
  if (opts.message !== undefined && opts.message !== null) {
    message = validateText(opts.message, { allowEmpty: true, what: 'Merge commit message' }) || undefined
  }
  const expectedHeadSha =
    opts.expectedHeadSha !== undefined && opts.expectedHeadSha !== null ? assertSha(opts.expectedHeadSha) : undefined
  return { method: opts.method, title, message, expectedHeadSha, deleteSourceBranch: opts.deleteSourceBranch === true }
}

/** `title` + blank line + `message`, or undefined when both are empty. */
export function commitMessage(title: string | undefined, message: string | undefined): string | undefined {
  if (title && message) return `${title}\n\n${message}`
  return title ?? message
}

/** True when two commit ids (full or abbreviated) name the same commit. */
export function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.length >= y.length ? x.startsWith(y) : y.startsWith(x)
}

/** Re-throw a ProviderError with a different code and message, keeping its HTTP status. */
export function recode(e: ProviderError, code: ProviderError['code'], message: string): ProviderError {
  return new ProviderError(code, message, e.status !== undefined ? { status: e.status } : {})
}

/** The "<Label> said: ..." part of a ProviderError message, or ''. */
export function providerDetail(e: ProviderError): string {
  const i = e.message.indexOf(' said: ')
  return i >= 0 ? e.message.slice(i + ' said: '.length) : ''
}

/** Merge reviewer entries by login; later entries win. Keeps first-seen order. */
export function dedupeReviewers(entries: { login: string; state: ReviewerState }[]): PullRequestReviewer[] {
  const map = new Map<string, ReviewerState>()
  for (const e of entries) if (e.login) map.set(e.login, e.state)
  return [...map].map(([login, state]) => ({ login, state }))
}

/** Parse a positive integer that providers sometimes send as a string ("12", GitLab "1000+" → null). */
export function optCount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return null
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit < 1) throw new ProviderError('INVALID_ARGUMENT', 'Invalid result limit.')
  return Math.min(limit, 100)
}

// ---------------------------------------------------------------------------
// Defensive JSON access

export type Json = Record<string, unknown>

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function expectObject(v: unknown, label: string): Json {
  if (!isObject(v)) throw new ProviderError('BAD_RESPONSE', `${label} returned an unexpected response.`)
  return v
}

export function expectArray(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) throw new ProviderError('BAD_RESPONSE', `${label} returned an unexpected response.`)
  return v
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function optStr(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

export function num(v: unknown, label: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  throw new ProviderError('BAD_RESPONSE', `${label} returned an item without a numeric id.`)
}

export function obj(v: unknown): Json {
  return isObject(v) ? v : {}
}

export function stripHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

// ---------------------------------------------------------------------------
// Pagination

export const MAX_PAGES = 3

/** The `rel="next"` URL of an RFC 8288 Link header. */
export function parseLinkNext(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const m = /^<([^>]+)>(.*)$/.exec(part.trim())
    const rel = m ? /;\s*rel\s*=\s*"?([^";]*)"?/i.exec(m[2]!) : null
    if (m && rel && rel[1]!.toLowerCase().split(/\s+/).includes('next')) return m[1]!
  }
  return null
}

/** Fetch up to `limit` items over at most MAX_PAGES pages. */
export async function paginate<T>(
  limit: number,
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>,
): Promise<T[]> {
  const out: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items, next } = await fetchPage(cursor)
    out.push(...items)
    if (out.length >= limit || !next || items.length === 0) break
    cursor = next
  }
  return out.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Checks

export type CheckItemState = 'success' | 'failure' | 'pending' | 'neutral'

export interface CheckItem {
  state: CheckItemState
  url?: string | null
}

export function summarizeChecks(items: CheckItem[]): CheckStatus {
  const failed = items.filter((i) => i.state === 'failure')
  const pending = items.filter((i) => i.state === 'pending')
  const total = items.length
  const state: CheckStatus['state'] =
    total === 0 ? 'none' : failed.length > 0 ? 'failure' : pending.length > 0 ? 'pending' : 'success'
  const pick = failed[0] ?? pending[0] ?? items[0]
  const url = [pick, ...items].map((i) => safeWebUrl(i?.url)).find(Boolean)
  return { state, total, failed: failed.length, pending: pending.length, ...(url ? { url } : {}) }
}

/** Validate an inline comment target (path inside the repository, positive line, sha). */
export function validateLineComment(input: LineCommentInput, maxBody = MAX_BODY): LineCommentInput {
  const okPath = (p: unknown): p is string =>
    typeof p === 'string' && p.length > 0 && p.length <= 4096 && !p.startsWith('/') && !p.includes('\0') && !p.split('/').includes('..')
  if (!okPath(input?.path) || (input.oldPath !== undefined && !okPath(input.oldPath))) {
    throw new ProviderError('INVALID_ARGUMENT', 'Invalid file path.')
  }
  if (!Number.isInteger(input.line) || input.line < 1 || input.line > 10_000_000) throw new ProviderError('INVALID_ARGUMENT', 'Invalid line number.')
  if (input.side !== 'old' && input.side !== 'new') throw new ProviderError('INVALID_ARGUMENT', 'Invalid diff side.')
  return { ...input, headSha: assertSha(input.headSha), body: validateText(input.body, { max: maxBody }) }
}

/** An https(:) clone URL with any user info removed; null if it isn't one. */
export function safeCloneUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u) return null
  try {
    const p = new URL(u)
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return null
    p.username = ''
    p.password = ''
    return p.href
  } catch {
    return null
  }
}

/** An ssh clone URL (`git@host:path` or `ssh://…`) without whitespace or a leading dash; else null. */
export function safeSshUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u || /\s/.test(u) || u.startsWith('-')) return null
  return /^ssh:\/\/[^/]+\/./.test(u) || /^[\w.-]+@[\w.-]+:[^/]/.test(u) ? u : null
}

/** Limit for repository listings: 1..300, default 300. */
export function repoLimit(limit: number | undefined): number {
  if (limit === undefined) return 300
  if (!Number.isInteger(limit) || limit < 1) throw new ProviderError('INVALID_ARGUMENT', 'Invalid result limit.')
  return Math.min(limit, 300)
}

/** Encode each path segment of a branch name (keeps `/` separators). */
export function encodeBranchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/')
}

/**
 * Provider-supplied links (CI target URLs can be set by anyone allowed to post a commit status)
 * are only kept if they are http(s); anything else (javascript:, file:, data:) becomes undefined.
 */
export function safeWebUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined
  try {
    const p = new URL(u)
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : undefined
  } catch {
    return undefined
  }
}

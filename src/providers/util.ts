import { ProviderError, type CheckStatus, type CreatePullRequestInput, type ProviderKind, type RepoRef } from './types'

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
  const url = [pick, ...items].find((i) => i?.url)?.url ?? undefined
  return { state, total, failed: failed.length, pending: pending.length, ...(url ? { url } : {}) }
}

/** Encode each path segment of a branch name (keeps `/` separators). */
export function encodeBranchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/')
}

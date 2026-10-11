import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommitPage, CommitSummary } from '@shared/types'
import { GitError } from './errors'
import { LITERAL_PATHSPECS_ENV, resolveRepoPath } from './paths'
import { getHead } from './refs'
import { runGit } from './runner'
import type { HistoryFilter } from '@shared/types'

/** Fields emitted per commit, NUL separated; with -z commits are also NUL separated. */
const LOG_FIELDS = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s'] as const
export const LOG_FORMAT = LOG_FIELDS.join('%x00')
const FIELD_COUNT = LOG_FIELDS.length

/** Parse `git log -z --format=LOG_FORMAT` output. */
export function parseLog(stdout: string): CommitSummary[] {
  if (!stdout) return []
  // Trailing newline/NUL handling: git terminates each record with NUL under -z (except possibly the last).
  const tokens = stdout.replace(/\0?\n?$/, '').split('\0')
  if (tokens.length % FIELD_COUNT !== 0) {
    throw new Error(`Malformed git log output: ${tokens.length} fields is not a multiple of ${FIELD_COUNT}`)
  }
  const commits: CommitSummary[] = []
  for (let i = 0; i < tokens.length; i += FIELD_COUNT) {
    const [sha, parents, an, ae, at, cn, ce, ct, subject] = tokens.slice(i, i + FIELD_COUNT) as string[]
    commits.push({
      sha: sha!.replace(/^\n/, ''),
      parents: parents ? parents.split(' ') : [],
      authorName: an!,
      authorEmail: ae!,
      authorTime: Number(at),
      committerName: cn!,
      committerEmail: ce!,
      commitTime: Number(ct),
      subject: subject!,
    })
  }
  return commits
}

/** Graph filter; see HistoryFilter in @shared/types. */
export type LogFilter = HistoryFilter

export interface LogPageOptions {
  skip: number
  limit: number
  signal?: AbortSignal
  filter?: LogFilter
  /** Branches / tags hidden from the graph (full ref names); commits only they reach are left out. */
  hidden?: readonly string[]
}

const HIDDEN_REF_RE = /^refs\/(heads|remotes|tags)\/[^\s*?[\\]+$/

/**
 * `--branches --remotes --tags` with hidden refs excluded. git's `--exclude` patterns apply to the
 * next group only and are written without that group's `refs/heads/` (… ) prefix.
 */
export function refGroups(hidden: readonly string[] = []): string[] {
  const valid = hidden.filter((r) => HIDDEN_REF_RE.test(r) && !r.includes('..')).slice(0, 1000)
  const group = (prefix: string, flag: string): string[] => [
    ...valid.filter((r) => r.startsWith(prefix)).map((r) => `--exclude=${r.slice(prefix.length)}`),
    flag,
  ]
  return [...group('refs/heads/', '--branches'), ...group('refs/remotes/', '--remotes'), ...group('refs/tags/', '--tags')]
}

/**
 * Ordered commit ids of one full `git rev-list --date-order` walk, valid for
 * one exact state of the walk's inputs (`fingerprint`).
 *
 * `git log --skip=N` re-walks (and, without a commit-graph file, re-sorts) the
 * whole history for every page, so loading 100k commits in 2k pages costs ~50
 * full walks. Instead, pages after the first are served by slicing this list
 * and formatting just those commits with `git log --no-walk=unsorted --stdin`.
 * Commit objects are immutable, so the order only changes when a walk input
 * changes: a ref tip, HEAD, a replace ref, or the shallow boundary - all of
 * which are part of the fingerprint.
 */
interface WalkOrder {
  fingerprint: string
  /** Newline-terminated, fixed-width object ids exactly as printed by rev-list. */
  ids: string
  /** Characters per entry (object id length + 1 for the newline). */
  stride: number
  count: number
}

const MAX_CACHED_REPOS = 4
const walkCache = new Map<string, WalkOrder>()
const walkBuilds = new Map<string, Promise<WalkOrder>>()
const shallowPaths = new Map<string, string>()

/** Drop cached walk orders (all repositories, or one). Exposed for tests. */
export function clearLogCache(repoPath?: string): void {
  if (repoPath === undefined) {
    walkCache.clear()
    shallowPaths.clear()
  } else {
    walkCache.delete(repoPath)
    shallowPaths.delete(repoPath)
  }
}

/** Refs that feed the history walk; replace refs rewrite parents, so they are part of the fingerprint. */
const WALK_REFS = ['refs/heads', 'refs/remotes', 'refs/tags', 'refs/replace'] as const
const VISIBLE_REF = /^\S+ refs\/(?:heads|remotes|tags)\//m

async function shallowState(repoPath: string, signal?: AbortSignal): Promise<string> {
  let path = shallowPaths.get(repoPath)
  if (path === undefined) {
    const { stdout } = await runGit(['rev-parse', '--git-path', 'shallow'], { cwd: repoPath, signal })
    path = resolve(repoPath, stdout.trim())
    shallowPaths.set(repoPath, path)
  }
  try {
    const st = await stat(path)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'none'
  }
}

/** Reject with CANCELLED as soon as `signal` aborts, without cancelling the shared work. */
function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new GitError('CANCELLED', 'Git command was cancelled'))
  return new Promise<T>((res, rej) => {
    const onAbort = (): void => rej(new GitError('CANCELLED', 'Git command was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        res(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        rej(e)
      },
    )
  })
}

function getWalkOrder(repoPath: string, fingerprint: string, revs: readonly string[], signal?: AbortSignal): Promise<WalkOrder> {
  const cached = walkCache.get(repoPath)
  if (cached?.fingerprint === fingerprint) {
    // Refresh LRU position.
    walkCache.delete(repoPath)
    walkCache.set(repoPath, cached)
    return Promise.resolve(cached)
  }
  const key = `${repoPath}\0${fingerprint}`
  let build = walkBuilds.get(key)
  if (!build) {
    // Shared by concurrent callers, so it is not tied to any caller's signal.
    build = runGit(['rev-list', '--date-order', ...revs, '--'], { cwd: repoPath, timeoutMs: 120_000 })
      .then(({ stdout }) => {
        const nl = stdout.indexOf('\n')
        const stride = nl === -1 ? 1 : nl + 1
        const order: WalkOrder = { fingerprint, ids: stdout, stride, count: Math.floor(stdout.length / stride) }
        if (order.count * stride !== stdout.length) throw new Error('Unexpected git rev-list output')
        walkCache.delete(repoPath)
        walkCache.set(repoPath, order)
        while (walkCache.size > MAX_CACHED_REPOS) walkCache.delete(walkCache.keys().next().value!)
        return order
      })
      .finally(() => walkBuilds.delete(key))
    walkBuilds.set(key, build)
  }
  return withAbort(build, signal)
}

async function pageFromWalkOrder(
  repoPath: string,
  fingerprint: string,
  revs: readonly string[],
  opts: LogPageOptions,
): Promise<CommitPage> {
  const { signal } = opts
  const order = await getWalkOrder(repoPath, fingerprint, revs, signal)
  if (opts.skip >= order.count) return { commits: [], hasMore: false }
  const end = Math.min(order.count, opts.skip + opts.limit)
  const ids = order.ids.slice(opts.skip * order.stride, end * order.stride)
  const { stdout } = await runGit(['log', '--no-walk=unsorted', '--stdin', '-z', `--format=${LOG_FORMAT}`], {
    cwd: repoPath,
    signal,
    input: ids,
    timeoutMs: 120_000,
  })
  const commits = parseLog(stdout)
  if (commits.length !== end - opts.skip) throw new Error('git log returned a different number of commits than requested')
  return { commits, hasMore: end < order.count }
}

function trimPage(commits: CommitSummary[], limit: number): CommitPage {
  const hasMore = commits.length > limit
  if (hasMore) commits.length = limit
  return { commits, hasMore }
}

const FILTER_REF_RE = /^refs\/(?:heads|remotes|tags)\/[^\0\s~^:?*[\\]+$/
const MAX_FILTER_REFS = 500
const MAX_AUTHOR_LENGTH = 200

interface NormalizedFilter {
  refs: string[]
  author: string
  path: string
}

/** Validate a filter; returns null when it restricts nothing. */
async function normalizeFilter(repoPath: string, filter: LogFilter | undefined, signal?: AbortSignal): Promise<NormalizedFilter | null> {
  if (!filter) return null
  const refs = filter.refs ?? []
  const author = filter.author ?? ''
  const path = filter.path ?? ''
  if (!Array.isArray(refs) || typeof author !== 'string' || typeof path !== 'string') {
    throw new GitError('INVALID_ARGUMENT', 'Invalid history filter')
  }
  if (refs.length > MAX_FILTER_REFS) throw new GitError('INVALID_ARGUMENT', 'Too many refs in history filter')
  for (const ref of refs) {
    if (typeof ref !== 'string' || !FILTER_REF_RE.test(ref) || ref.includes('..') || ref.includes('@{')) {
      throw new GitError('INVALID_ARGUMENT', `Invalid ref in history filter: ${String(ref)}`)
    }
  }
  if (author.length > MAX_AUTHOR_LENGTH || author.includes('\0')) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid author filter')
  }
  if (path) resolveRepoPath(repoPath, path)
  if (!refs.length && !author && !path) return null
  if (refs.length) {
    const r = await runGit(['show-ref', '--verify', '--quiet', ...refs], { cwd: repoPath, signal, okExitCodes: [0, 1, 128] })
    if (r.exitCode !== 0) throw new GitError('INVALID_ARGUMENT', 'A ref in the history filter does not exist')
  }
  return { refs: [...new Set(refs)], author, path }
}

/**
 * Filtered pages use a plain positional walk (`--skip`) rather than the cached
 * walk order: filtered result sets are usually small, a cache keyed by filter
 * would rarely be reused, and the walk is then trivially identical to one full
 * `git log --date-order` with the same arguments.
 *
 * `--parents` turns on parent rewriting, so with a path filter `%P` lists the
 * nearest ancestors that are themselves part of the filtered history and the
 * graph stays connected. Default history simplification applies (TREESAME
 * merges are followed along one parent, no `--full-history`), renames are not
 * followed, and the path is matched literally (GIT_LITERAL_PATHSPECS=1).
 * `--author` is matched as a fixed string (`-F`), case-insensitively (`-i`).
 */
function filteredLogArgs(filter: NormalizedFilter, skip: number, maxCount: number, unbornHead: boolean, hidden: readonly string[] = []): string[] {
  const args = ['log', '-z', '--date-order', '--parents', `--format=${LOG_FORMAT}`, `--skip=${skip}`, `--max-count=${maxCount}`]
  if (filter.author) args.push('-F', '-i', `--author=${filter.author}`)
  if (filter.refs.length) args.push(...filter.refs)
  else args.push(...refGroups(hidden), ...(unbornHead ? [] : ['HEAD']))
  args.push('--')
  if (filter.path) args.push(filter.path)
  return args
}

/**
 * Load one page of history across all local branches, remote branches, tags
 * and HEAD (or, with `filter`, the filtered history), in date order (children
 * always before parents).
 *
 * Pages are positional (`skip`/`limit`) and concatenate to exactly one full
 * `git log --date-order` run as long as the repository's refs do not change
 * between calls.
 */
export async function getCommitPage(repoPath: string, opts: LogPageOptions): Promise<CommitPage> {
  const { signal } = opts
  const filter = await normalizeFilter(repoPath, opts.filter, signal)
  if (filter) {
    const head = filter.refs.length ? null : await getHead(repoPath)
    if (head?.unborn) {
      const refs = await runGit(['for-each-ref', '--format=%(objectname) %(refname)', ...WALK_REFS], { cwd: repoPath, signal })
      if (!VISIBLE_REF.test(refs.stdout)) return { commits: [], hasMore: false }
    }
    const { stdout } = await runGit(filteredLogArgs(filter, opts.skip, opts.limit + 1, head?.unborn ?? false, opts.hidden), {
      cwd: repoPath,
      signal,
      timeoutMs: 120_000,
      env: LITERAL_PATHSPECS_ENV,
    })
    return trimPage(parseLog(stdout), opts.limit)
  }
  const [head, refs, shallow] = await Promise.all([
    getHead(repoPath),
    runGit(['for-each-ref', '--format=%(objectname) %(refname)', ...WALK_REFS], { cwd: repoPath, signal }),
    opts.skip > 0 ? shallowState(repoPath, signal) : '',
  ])
  // An empty repository (no commits on any ref) has nothing to show.
  if (head.unborn && !VISIBLE_REF.test(refs.stdout)) return { commits: [], hasMore: false }
  const revs = refGroups(opts.hidden)
  if (!head.unborn) revs.push('HEAD')

  if (opts.skip > 0) {
    try {
      const fingerprint = [head.sha ?? '-', shallow, revs.join(' '), refs.stdout].join('\n')
      return await pageFromWalkOrder(repoPath, fingerprint, revs, opts)
    } catch (err) {
      if (err instanceof GitError && err.code === 'CANCELLED') throw err
      // Anything unexpected (e.g. objects pruned mid-read): drop the cache and
      // fall back to the always-correct, slower positional walk below.
      clearLogCache(repoPath)
    }
  }

  // First page (or fallback): a single bounded walk is fastest for the first
  // page (git stops after limit+1 commits when a commit-graph allows
  // incremental date ordering).
  const { stdout } = await runGit(
    [
      'log',
      '-z',
      '--date-order',
      `--format=${LOG_FORMAT}`,
      `--skip=${opts.skip}`,
      `--max-count=${opts.limit + 1}`,
      ...revs,
      '--',
    ],
    { cwd: repoPath, signal, timeoutMs: 120_000 },
  )
  return trimPage(parseLog(stdout), opts.limit)
}

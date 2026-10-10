import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GitError } from './errors'
import { runGit } from './runner'
import { getOperation, runStatus } from './status'
import type { RebaseTodoItem } from '@shared/types'
export type { RebaseTodoItem }

import type { RebaseAction } from '@shared/types'
export type { RebaseAction }


export interface RebaseTodoCommit {
  sha: string
  subject: string
  authorName: string
  /** Author time, unix seconds. */
  time: number
}

export interface InteractiveRebaseResult {
  /** false: git stopped (conflict, failed hook, ...) and the rebase is still in progress. */
  completed: boolean
}

const SHA_RE = /^[0-9a-f]{4,64}$/i
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ACTIONS: ReadonlySet<string> = new Set(['pick', 'reword', 'squash', 'fixup', 'drop'])
const MAX_COMMITS = 2000
const REBASE_TIMEOUT = 15 * 60_000
const ALL_EXIT_CODES = Array.from({ length: 256 }, (_, i) => i)
/** Directory (inside the git dir) holding message files referenced by `exec` lines. */
const MSG_DIR = 'gitbob-rebase'

function invalid(message: string): GitError {
  return new GitError('INVALID_ARGUMENT', message)
}

/** POSIX single-quote a path for the fixed shell snippets git runs. Newlines would break the todo format. */
function shellQuotePath(p: string): string {
  if (/[\0\r\n]/.test(p)) throw new GitError('INTERNAL', 'Temporary path contains unsupported characters')
  return `'${p.replace(/'/g, `'\\''`)}'`
}

async function resolveCommitSha(repoPath: string, rev: string): Promise<string> {
  if (typeof rev !== 'string' || !SHA_RE.test(rev)) throw invalid('Invalid commit id')
  const r = await runGit(['rev-parse', '-q', '--verify', `${rev}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1, 128] })
  const sha = r.stdout.trim()
  if (r.exitCode !== 0 || !sha) throw new GitError('NOT_FOUND', `Commit ${rev} not found`)
  return sha
}

async function assertOnBranch(repoPath: string): Promise<string> {
  const head = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1, 128] })
  if (head.exitCode !== 0) throw invalid('The current branch has no commits yet')
  const sym = await runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: repoPath, okExitCodes: [0, 1] })
  if (sym.exitCode !== 0) throw invalid('Interactive rebase requires a checked-out branch (HEAD is detached)')
  return head.stdout.trim()
}

/**
 * Commits that an interactive rebase onto `base` would rewrite (`base..HEAD`), oldest first.
 * Only linear history is supported: ranges containing merge commits are rejected.
 */
export async function getRebaseTodo(repoPath: string, base: string): Promise<RebaseTodoCommit[]> {
  const head = await assertOnBranch(repoPath)
  const baseSha = await resolveCommitSha(repoPath, base)
  const anc = await runGit(['merge-base', '--is-ancestor', baseSha, head], { cwd: repoPath, okExitCodes: [0, 1] })
  if (anc.exitCode !== 0) throw invalid('The base commit is not an ancestor of HEAD')

  const count = Number(
    (await runGit(['rev-list', '--count', `${baseSha}..${head}`, '--'], { cwd: repoPath })).stdout.trim(),
  )
  if (count > MAX_COMMITS) throw invalid(`Too many commits to rebase interactively (${count}, limit ${MAX_COMMITS})`)

  const { stdout } = await runGit(
    ['log', '-z', '--reverse', '--no-abbrev-commit', '--format=%H%x00%P%x00%an%x00%at%x00%s', `${baseSha}..${head}`, '--'],
    { cwd: repoPath },
  )
  const tokens = stdout.split('\0')
  const out: RebaseTodoCommit[] = []
  for (let i = 0; i + 4 < tokens.length; i += 5) {
    const sha = (tokens[i] ?? '').replace(/^\n/, '')
    if (!sha) continue
    const parents = (tokens[i + 1] ?? '').split(' ').filter(Boolean)
    if (parents.length > 1) throw invalid('Interactive rebase of merge commits is not supported')
    out.push({ sha, authorName: tokens[i + 2] ?? '', time: Number(tokens[i + 3]) || 0, subject: tokens[i + 4] ?? '' })
  }
  return out
}

function validateTodo(todo: unknown, commits: RebaseTodoCommit[]): RebaseTodoItem[] {
  if (!Array.isArray(todo) || todo.length === 0) throw invalid('The rebase plan is empty')
  const expected = new Set(commits.map((c) => c.sha))
  const seen = new Set<string>()
  const items: RebaseTodoItem[] = []
  for (const raw of todo as unknown[]) {
    if (!raw || typeof raw !== 'object') throw invalid('Invalid rebase plan entry')
    const { sha, action, message } = raw as Record<string, unknown>
    if (typeof sha !== 'string' || !FULL_SHA_RE.test(sha.toLowerCase())) throw invalid('Invalid commit id in rebase plan')
    const id = sha.toLowerCase()
    if (typeof action !== 'string' || !ACTIONS.has(action)) throw invalid(`Invalid rebase action for ${id.slice(0, 7)}`)
    if (!expected.has(id)) throw invalid(`Commit ${id.slice(0, 7)} is not part of the rebased range`)
    if (seen.has(id)) throw invalid(`Commit ${id.slice(0, 7)} appears more than once in the rebase plan`)
    seen.add(id)
    if (message !== undefined) {
      if (action !== 'reword' && action !== 'squash') throw invalid(`A message is only allowed for reword and squash`)
      if (typeof message !== 'string' || message.trim().length === 0 || message.includes('\0')) {
        throw invalid(`Invalid commit message for ${id.slice(0, 7)}`)
      }
    }
    if (action === 'reword' && message === undefined) throw invalid(`Reword of ${id.slice(0, 7)} needs a message`)
    items.push({ sha: id, action: action as RebaseAction, ...(message !== undefined ? { message } : {}) })
  }
  if (seen.size !== expected.size) throw invalid('The rebase plan must list every commit of the range exactly once')
  const first = items.find((i) => i.action !== 'drop')
  if (first && (first.action === 'squash' || first.action === 'fixup')) {
    throw invalid('The first commit cannot be squashed or fixed up into a previous commit')
  }
  return items
}

/**
 * Build the todo file. User text never appears in it: messages are written to files in `msgDir`
 * and referenced by fixed `exec` commands that only contain paths we created.
 */
async function buildTodo(items: RebaseTodoItem[], msgDir: string): Promise<string> {
  const lines: string[] = []
  let n = 0
  const amendWith = async (message: string): Promise<string> => {
    const file = join(msgDir, `msg-${n++}`)
    await writeFile(file, message.endsWith('\n') ? message : message + '\n', { mode: 0o600 })
    // --no-verify mirrors git's own reword, which skips pre-commit; --allow-empty keeps empty commits rewordable.
    return `exec git commit --amend --no-edit --no-verify --allow-empty -F ${shellQuotePath(file)}`
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.action === 'drop') {
      lines.push(`drop ${item.sha}`)
      continue
    }
    if (item.action === 'reword') {
      lines.push(`pick ${item.sha}`, await amendWith(item.message!))
    } else {
      lines.push(`${item.action} ${item.sha}`)
    }
    // A custom squash message applies to the combined commit once its squash/fixup chain ends.
    if (item.action === 'squash' || item.action === 'fixup') {
      const next = items.slice(i + 1).find((x) => x.action !== 'drop')
      const chainEnds = !next || (next.action !== 'squash' && next.action !== 'fixup')
      if (chainEnds) {
        let custom: string | undefined
        for (let j = i; j >= 0; j--) {
          const prev = items[j]!
          if (prev.action === 'drop') continue
          if (prev.action !== 'squash' && prev.action !== 'fixup') break
          if (prev.action === 'squash' && prev.message !== undefined) {
            custom = prev.message
            break
          }
        }
        if (custom !== undefined) lines.push(await amendWith(custom))
      }
    }
  }
  return lines.join('\n') + '\n'
}

async function assertCleanTrackedTree(repoPath: string): Promise<void> {
  const { entries } = await runStatus(repoPath)
  if (entries.some((e) => e.kind === 'unmerged')) throw invalid('Resolve the conflicted files first')
  if (entries.some((e) => (e.kind === 'ordinary' || e.kind === 'renamed') && (e.index !== '.' || e.worktree !== '.'))) {
    throw invalid('Commit or stash your changes before rebasing')
  }
}

async function messageRoot(repoPath: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--git-path', MSG_DIR], { cwd: repoPath })
  return resolve(repoPath, stdout.trim())
}

/** Remove message files left by an earlier rebase that has since finished or been aborted. */
export async function cleanupRebaseFiles(repoPath: string): Promise<void> {
  if (await getOperation(repoPath)) return
  await rm(await messageRoot(repoPath), { recursive: true, force: true })
}

/**
 * Rewrite `base..HEAD` according to `todo` with `git rebase -i`. The prepared todo is installed by
 * a fixed GIT_SEQUENCE_EDITOR command; no editor is ever shown. Returns `completed: false` when git
 * stops (e.g. conflicts) with the rebase left in progress for continue/skip/abort.
 */
export async function interactiveRebase(
  repoPath: string,
  base: string,
  todo: RebaseTodoItem[],
): Promise<InteractiveRebaseResult> {
  const op = await getOperation(repoPath)
  if (op) throw invalid(`A ${op} is already in progress; finish or abort it first`)
  const commits = await getRebaseTodo(repoPath, base)
  const items = validateTodo(todo, commits)
  await assertCleanTrackedTree(repoPath)
  const baseSha = await resolveCommitSha(repoPath, base)

  // Message files must outlive this call (exec lines run again after `rebase --continue`), so
  // they live in the git dir; the todo itself is consumed immediately and goes to a temp dir.
  const root = await messageRoot(repoPath)
  await rm(root, { recursive: true, force: true })
  const msgDir = join(root, randomBytes(8).toString('hex'))
  await mkdir(msgDir, { recursive: true, mode: 0o700 })
  const tmp = await mkdtemp(join(tmpdir(), 'gitbob-rebase-'))
  let stopped = false
  try {
    const todoFile = join(tmp, 'git-rebase-todo')
    await writeFile(todoFile, await buildTodo(items, msgDir), { mode: 0o600 })
    const r = await runGit(
      ['rebase', '-i', '--no-autosquash', '--no-autostash', '--no-rebase-merges', baseSha],
      {
        cwd: repoPath,
        timeoutMs: REBASE_TIMEOUT,
        okExitCodes: ALL_EXIT_CODES,
        env: {
          // git runs this as `sh -c '<value> "$@"' <todo path>`: a fixed command, only our own path.
          GIT_SEQUENCE_EDITOR: `cp ${shellQuotePath(todoFile)}`,
          // Squash without a custom message keeps git's combined message.
          GIT_EDITOR: 'true',
        },
      },
    )
    const after = await getOperation(repoPath)
    if (after === 'rebase') {
      stopped = true
      return { completed: false }
    }
    if (r.exitCode !== 0) {
      const detail = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n')
      const first = (detail.split('\n').find((l) => l.trim()) ?? '').replace(/^(fatal|error): /, '')
      throw new GitError('GIT_FAILED', first || `git rebase exited with code ${r.exitCode}`, { detail, exitCode: r.exitCode })
    }
    return { completed: true }
  } finally {
    await rm(tmp, { recursive: true, force: true })
    if (!stopped) await rm(root, { recursive: true, force: true })
  }
}

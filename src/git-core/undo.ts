import { GitError } from './errors'
import { reset } from './history'
import { runGit } from './runner'
import { getOperation, runStatus } from './status'

/**
 * Building blocks for undo/redo. Every step names the exact state it expects (HEAD commit and
 * branch, or a ref's old value) and refuses to run if the repository has moved on, so an undo
 * can never act on a state the user did not see. Steps only use non-destructive forms:
 * `reset --keep` (refuses to overwrite local changes), `update-ref` with an old-value check,
 * and `switch` (refuses to overwrite local changes).
 */

/** HEAD commit (null on an unborn branch) and the symbolic ref it is on (null when detached). */
export interface HeadSnapshot {
  sha: string | null
  ref: string | null
}

export type UndoStep =
  /** Move the current branch (and for keep/mixed: index/worktree) to `to`. */
  | { type: 'reset'; mode: 'soft' | 'mixed' | 'keep'; expect: HeadSnapshot; to: string }
  /** Hard reset to `to`, backing up local changes first (redo of a hard reset). */
  | { type: 'hard-reset'; expect: HeadSnapshot; to: string }
  /** Undo a hard reset: back to `to` and re-apply the backup stash it made, if any. */
  | { type: 'restore-hard-reset'; expect: HeadSnapshot; to: string; backupStash: string | null }
  /** Switch back to a branch or detached commit. */
  | { type: 'checkout'; expect: HeadSnapshot; to: HeadSnapshot }
  /** Create (from null), delete (to null) or move a ref, only if it still has value `from`. */
  | { type: 'ref'; ref: string; from: string | null; to: string | null }
  | { type: 'rename-branch'; from: string; to: string }

const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const REF_RE = /^refs\/(heads|tags)\/[^\s~^:?*[\\]+$/

export async function headSnapshot(repoPath: string): Promise<HeadSnapshot> {
  const [sha, ref] = await Promise.all([
    runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1, 128] }),
    runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: repoPath, okExitCodes: [0, 1] }),
  ])
  return {
    sha: sha.exitCode === 0 ? sha.stdout.trim() : null,
    ref: ref.exitCode === 0 ? ref.stdout.trim() : null,
  }
}

/** Object id a ref points to (not peeled), or null if it doesn't exist. */
export async function readRef(repoPath: string, ref: string): Promise<string | null> {
  assertRef(ref)
  const r = await runGit(['rev-parse', '-q', '--verify', `${ref}`], { cwd: repoPath, okExitCodes: [0, 1, 128] })
  return r.exitCode === 0 ? r.stdout.trim() : null
}

function assertRef(ref: string): void {
  if (!REF_RE.test(ref) || ref.includes('..') || ref.endsWith('.lock') || ref.endsWith('/')) {
    throw new GitError('INVALID_ARGUMENT', `Invalid ref: ${ref}`)
  }
}

function assertOid(oid: string | null): void {
  if (oid !== null && !OID_RE.test(oid)) throw new GitError('INVALID_ARGUMENT', 'Invalid object id')
}

const sameHead = (a: HeadSnapshot, b: HeadSnapshot): boolean => a.sha === b.sha && a.ref === b.ref

/** Thrown when the repository is no longer in the state an undo/redo step expects. */
export class StaleUndoError extends GitError {
  constructor() {
    super('GIT_FAILED', 'The repository has changed since then, so this can no longer be undone or redone safely.')
  }
}

async function expectHead(repoPath: string, expect: HeadSnapshot): Promise<void> {
  if (!sameHead(await headSnapshot(repoPath), expect)) throw new StaleUndoError()
}

async function expectRef(repoPath: string, ref: string, value: string | null): Promise<void> {
  if ((await readRef(repoPath, ref)) !== value) throw new StaleUndoError()
}

async function expectNoOperation(repoPath: string): Promise<void> {
  const op = await getOperation(repoPath)
  if (op) throw new GitError('GIT_FAILED', `A ${op} is in progress. Finish or abort it first.`)
}

/** Check a step's preconditions without changing anything. */
async function check(repoPath: string, step: UndoStep): Promise<void> {
  switch (step.type) {
    case 'reset':
    case 'hard-reset':
    case 'restore-hard-reset':
    case 'checkout':
      assertOid(step.type === 'checkout' ? step.to.sha : step.to)
      await expectHead(repoPath, step.expect)
      return
    case 'ref':
      assertRef(step.ref)
      assertOid(step.from)
      assertOid(step.to)
      await expectRef(repoPath, step.ref, step.from)
      if (step.to === null && (await headSnapshot(repoPath)).ref === step.ref) {
        throw new GitError('GIT_FAILED', 'That branch is checked out. Switch to another branch first.')
      }
      return
    case 'rename-branch':
      await expectRef(repoPath, `refs/heads/${step.to}`, null)
      if ((await readRef(repoPath, `refs/heads/${step.from}`)) === null) throw new StaleUndoError()
      return
  }
}

async function run(repoPath: string, step: UndoStep): Promise<void> {
  switch (step.type) {
    case 'reset':
      await runGit(['reset', '--quiet', `--${step.mode}`, step.to, '--'], { cwd: repoPath })
      return
    case 'hard-reset':
      await reset(repoPath, step.to, 'hard')
      return
    case 'restore-hard-reset': {
      const { entries } = await runStatus(repoPath)
      if (entries.some((e) => e.kind !== 'untracked' && e.kind !== 'ignored')) {
        throw new GitError('GIT_FAILED', 'You have uncommitted changes. Commit or stash them before undoing the hard reset.')
      }
      await runGit(['reset', '--quiet', '--keep', step.to, '--'], { cwd: repoPath })
      if (step.backupStash) {
        assertOid(step.backupStash)
        await runGit(['stash', 'apply', '--index', step.backupStash], { cwd: repoPath })
      }
      return
    }
    case 'checkout':
      if (step.to.ref) {
        if (!step.to.ref.startsWith('refs/heads/')) throw new GitError('INVALID_ARGUMENT', 'Invalid branch')
        await runGit(['switch', '--no-guess', step.to.ref.slice('refs/heads/'.length)], { cwd: repoPath })
      } else if (step.to.sha) {
        await runGit(['switch', '--detach', step.to.sha], { cwd: repoPath })
      }
      return
    case 'ref':
      if (step.to === null) await runGit(['update-ref', '-d', step.ref, step.from ?? ''], { cwd: repoPath })
      else await runGit(['update-ref', step.ref, step.to, step.from ?? ''], { cwd: repoPath })
      return
    case 'rename-branch':
      await runGit(['branch', '-m', step.from, step.to], { cwd: repoPath })
      return
  }
}

/**
 * Run steps in order. The first step's preconditions are checked before anything changes;
 * later steps are checked right before they run (they depend on the earlier ones).
 */
export async function applyUndoSteps(repoPath: string, steps: readonly UndoStep[]): Promise<void> {
  if (steps.length === 0) return
  await expectNoOperation(repoPath)
  for (const step of steps) {
    await check(repoPath, step)
    await run(repoPath, step)
  }
}

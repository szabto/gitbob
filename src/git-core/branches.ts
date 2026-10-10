import { GitError } from './errors'
import { runGit } from './runner'

const SHA_RE = /^[0-9a-f]{4,64}$/i

/** Validate a branch name with git itself (authoritative rules) plus a leading '-' guard. */
export async function assertValidBranchName(repoPath: string, name: string): Promise<void> {
  if (!name || name.startsWith('-') || name.includes('\0')) {
    throw new GitError('INVALID_ARGUMENT', `Invalid branch name: ${name}`)
  }
  try {
    const { stdout } = await runGit(['check-ref-format', '--branch', name], { cwd: repoPath })
    // check-ref-format --branch expands @{-N}; reject anything that is not taken literally.
    if (stdout.trim() !== name) throw new Error('expanded')
  } catch {
    throw new GitError('INVALID_ARGUMENT', `"${name}" is not a valid branch name`)
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const r = await runGit(['show-ref', '--verify', '--quiet', ref], { cwd: repoPath, okExitCodes: [0, 1] })
  return r.exitCode === 0
}

export async function createBranch(
  repoPath: string,
  name: string,
  opts: { startPoint: string; checkout: boolean },
): Promise<void> {
  await assertValidBranchName(repoPath, name)
  if (!SHA_RE.test(opts.startPoint)) throw new GitError('INVALID_ARGUMENT', 'Invalid start point')
  if (await refExists(repoPath, `refs/heads/${name}`)) {
    throw new GitError('INVALID_ARGUMENT', `A branch named "${name}" already exists`)
  }
  if (opts.checkout) {
    await runGit(['switch', '--no-guess', '-c', name, opts.startPoint], { cwd: repoPath })
  } else {
    await runGit(['branch', '--no-track', name, opts.startPoint], { cwd: repoPath })
  }
}

/**
 * Check out a branch by full ref name. Local branches are switched to; remote
 * branches switch to the matching local branch, creating it with tracking if
 * it does not exist yet. Git refuses (and we surface the error) if local
 * changes would be overwritten.
 */
export async function checkoutRef(repoPath: string, ref: string): Promise<{ branch: string }> {
  if (ref.startsWith('refs/heads/')) {
    const name = ref.slice('refs/heads/'.length)
    await assertValidBranchName(repoPath, name)
    if (!(await refExists(repoPath, ref))) throw new GitError('NOT_FOUND', `Branch ${name} does not exist`)
    await runGit(['switch', '--no-guess', name], { cwd: repoPath })
    return { branch: name }
  }
  if (ref.startsWith('refs/remotes/')) {
    const short = ref.slice('refs/remotes/'.length)
    const slash = short.indexOf('/')
    if (slash <= 0) throw new GitError('INVALID_ARGUMENT', `Invalid remote branch: ${short}`)
    const local = short.slice(slash + 1)
    await assertValidBranchName(repoPath, local)
    if (!(await refExists(repoPath, ref))) throw new GitError('NOT_FOUND', `Remote branch ${short} does not exist`)
    if (await refExists(repoPath, `refs/heads/${local}`)) {
      await runGit(['switch', '--no-guess', local], { cwd: repoPath })
    } else {
      await runGit(['switch', '--no-guess', '--track', '-c', local, short], { cwd: repoPath })
    }
    return { branch: local }
  }
  throw new GitError('INVALID_ARGUMENT', `Not a branch: ${ref}`)
}

export async function checkoutDetached(repoPath: string, sha: string): Promise<void> {
  if (!SHA_RE.test(sha)) throw new GitError('INVALID_ARGUMENT', 'Invalid commit id')
  await runGit(['switch', '--detach', sha], { cwd: repoPath })
}

export async function renameBranch(repoPath: string, oldName: string, newName: string): Promise<void> {
  await assertValidBranchName(repoPath, oldName)
  await assertValidBranchName(repoPath, newName)
  if (await refExists(repoPath, `refs/heads/${newName}`)) {
    throw new GitError('INVALID_ARGUMENT', `A branch named "${newName}" already exists`)
  }
  await runGit(['branch', '-m', oldName, newName], { cwd: repoPath })
}

/**
 * Delete a local branch. Without `force`, git refuses to delete branches that
 * are not merged into their upstream/HEAD; that refusal is reported with code
 * NOT_MERGED in the message so the UI can offer a forced delete.
 */
export async function deleteBranch(repoPath: string, name: string, opts: { force: boolean }): Promise<void> {
  await assertValidBranchName(repoPath, name)
  try {
    await runGit(['branch', opts.force ? '-D' : '-d', name], { cwd: repoPath })
  } catch (e) {
    if (e instanceof GitError && /not fully merged/i.test(e.detail ?? '')) {
      throw new GitError('GIT_FAILED', `Branch "${name}" is not fully merged`, { detail: e.detail })
    }
    throw e
  }
}

/** Set (`upstream` like "origin/main") or unset (`null`) the upstream of a local branch. */
export async function setUpstream(repoPath: string, name: string, upstream: string | null): Promise<void> {
  await assertValidBranchName(repoPath, name)
  if (upstream === null) {
    await runGit(['branch', '--unset-upstream', name], { cwd: repoPath })
    return
  }
  if (!(await refExists(repoPath, `refs/remotes/${upstream}`))) {
    throw new GitError('NOT_FOUND', `Remote branch ${upstream} does not exist`)
  }
  await runGit(['branch', `--set-upstream-to=${upstream}`, name], { cwd: repoPath })
}

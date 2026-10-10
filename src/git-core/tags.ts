import { GitError } from './errors'
import { assertValidRemoteName, type NetworkOptions } from './remotes'
import { runGit, type RunOptions } from './runner'
import type { TagInfo } from '@shared/types'
export type { TagInfo }


const SHA_RE = /^[0-9a-f]{4,64}$/i
const NETWORK_TIMEOUT = 10 * 60_000

const TAG_FIELDS = [
  '%(refname:strip=2)',
  '%(objecttype)',
  '%(objectname)',
  '%(*objecttype)',
  '%(*objectname)',
  '%(taggername)',
  '%(taggerdate:unix)',
  '%(contents:subject)',
  '%(contents:body)',
]
// Every field (including the last) is NUL-terminated; for-each-ref adds a newline after each record.
const TAG_FORMAT = TAG_FIELDS.map((f) => `${f}%00`).join('')

export interface RawTag {
  info: TagInfo
  /** Set when the tag points at another tag object and needs a full peel. */
  needsPeel: boolean
}

/** Parse `for-each-ref --format=TAG_FORMAT refs/tags` output. */
export function parseTags(stdout: string): RawTag[] {
  const tokens = stdout.split('\0')
  const n = TAG_FIELDS.length
  const out: RawTag[] = []
  for (let i = 0; i + n <= tokens.length; i += n) {
    const [rawName = '', type = '', object = '', peeledType = '', peeled = '', tagger = '', date = '', subject = '', body = ''] =
      tokens.slice(i, i + n)
    const name = rawName.replace(/^\n/, '')
    if (!name) continue
    const annotated = type === 'tag'
    const message = annotated ? [subject, body.replace(/\s+$/, '')].filter(Boolean).join('\n\n') : ''
    out.push({
      info: {
        name,
        target: annotated ? peeled || object : object,
        annotated,
        message,
        taggerName: annotated ? tagger || null : null,
        time: annotated && date ? Number(date) : null,
      },
      needsPeel: annotated && peeledType === 'tag',
    })
  }
  return out
}

/** All tags, newest first (by tagger date, or commit date for lightweight tags). */
export async function listTags(repoPath: string): Promise<TagInfo[]> {
  const { stdout } = await runGit(['for-each-ref', '--sort=-creatordate', `--format=${TAG_FORMAT}`, 'refs/tags'], {
    cwd: repoPath,
  })
  const raw = parseTags(stdout)
  const nested = raw.filter((t) => t.needsPeel)
  if (nested.length) {
    // Tags of tags: for-each-ref only peels one level; let cat-file peel fully.
    const r = await runGit(['cat-file', '--batch-check=%(objectname)'], {
      cwd: repoPath,
      input: nested.map((t) => `refs/tags/${t.info.name}^{}\n`).join(''),
    })
    const lines = r.stdout.split('\n')
    nested.forEach((t, i) => {
      const sha = lines[i]?.trim() ?? ''
      if (SHA_RE.test(sha)) t.info.target = sha
    })
  }
  return raw.map((t) => t.info)
}

/** Validate a tag name with git (`check-ref-format`) plus a leading '-' guard. */
export async function assertValidTagName(repoPath: string, name: string): Promise<void> {
  if (typeof name !== 'string' || !name || name.startsWith('-') || name.includes('\0') || name.includes('@{')) {
    throw new GitError('INVALID_ARGUMENT', `Invalid tag name: ${String(name)}`)
  }
  const r = await runGit(['check-ref-format', `refs/tags/${name}`], { cwd: repoPath, okExitCodes: [0, 1] })
  if (r.exitCode !== 0) throw new GitError('INVALID_ARGUMENT', `"${name}" is not a valid tag name`)
}

async function tagExists(repoPath: string, name: string): Promise<boolean> {
  const r = await runGit(['show-ref', '--verify', '--quiet', `refs/tags/${name}`], { cwd: repoPath, okExitCodes: [0, 1] })
  return r.exitCode === 0
}

/**
 * Create a tag on a commit. With a non-blank `message` the tag is annotated and the message is
 * passed on stdin (`-F -`); otherwise a lightweight tag is created. Existing tags are never moved.
 */
export async function createTag(repoPath: string, name: string, target: string, opts: { message?: string } = {}): Promise<void> {
  await assertValidTagName(repoPath, name)
  if (typeof target !== 'string' || !SHA_RE.test(target)) throw new GitError('INVALID_ARGUMENT', 'Invalid commit id')
  if (opts.message !== undefined && (typeof opts.message !== 'string' || opts.message.includes('\0'))) {
    throw new GitError('INVALID_ARGUMENT', 'Invalid tag message')
  }
  if (await tagExists(repoPath, name)) throw new GitError('INVALID_ARGUMENT', `A tag named "${name}" already exists`)
  const commit = await runGit(['rev-parse', '-q', '--verify', `${target}^{commit}`], { cwd: repoPath, okExitCodes: [0, 1] })
  if (commit.exitCode !== 0) throw new GitError('NOT_FOUND', `Commit ${target} not found`)
  const sha = commit.stdout.trim()

  const annotated = opts.message !== undefined && opts.message.trim().length > 0
  if (annotated) {
    await runGit(['tag', '--annotate', '--file=-', '--cleanup=strip', name, sha], {
      cwd: repoPath,
      input: opts.message,
      env: { GIT_EDITOR: 'true' },
    })
  } else {
    await runGit(['tag', name, sha], { cwd: repoPath })
  }
}

/** Delete a local tag. */
export async function deleteTag(repoPath: string, name: string): Promise<void> {
  await assertValidTagName(repoPath, name)
  if (!(await tagExists(repoPath, name))) throw new GitError('NOT_FOUND', `Tag ${name} does not exist`)
  await runGit(['tag', '--delete', name], { cwd: repoPath })
}

type TagNetworkOptions = Pick<NetworkOptions, 'env' | 'signal'>

async function networkRunOptions(repoPath: string, opts: TagNetworkOptions): Promise<RunOptions> {
  const env: Record<string, string> = { ...opts.env }
  // Fail fast instead of hanging on an invisible ssh prompt, unless the user configured ssh.
  if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH && !env.GIT_SSH_COMMAND) {
    const cfg = await runGit(['config', '--get', 'core.sshCommand'], { cwd: repoPath, okExitCodes: [0, 1] })
    if (!cfg.stdout.trim()) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  return { cwd: repoPath, env, timeoutMs: NETWORK_TIMEOUT, ...(opts.signal ? { signal: opts.signal } : {}) }
}

function pushError(e: unknown, name: string): never {
  if (e instanceof GitError && e.code === 'GIT_FAILED') {
    const d = e.detail ?? ''
    if (/remote ref does not exist/i.test(d)) {
      throw new GitError('NOT_FOUND', `The remote has no tag named "${name}"`, { detail: d })
    }
    if (/already exists|\[rejected\]/i.test(d)) {
      throw new GitError('GIT_FAILED', `The remote already has a different tag named "${name}"`, { detail: d })
    }
    if (/terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey/i.test(d)) {
      throw new GitError('GIT_FAILED', 'Authentication failed. Configure an SSH key or a Git credential helper.', { detail: d })
    }
  }
  throw e
}

/** Push one tag to a remote. Never force-moves an existing remote tag. */
export async function pushTag(repoPath: string, remote: string, name: string, opts: TagNetworkOptions = {}): Promise<void> {
  assertValidRemoteName(remote)
  await assertValidTagName(repoPath, name)
  if (!(await tagExists(repoPath, name))) throw new GitError('NOT_FOUND', `Tag ${name} does not exist`)
  await runGit(
    ['push', '--no-progress', remote, `refs/tags/${name}:refs/tags/${name}`],
    await networkRunOptions(repoPath, opts),
  ).catch((e: unknown) => pushError(e, name))
}

/** Delete a tag on a remote. Destructive for other users of the remote: the UI must confirm first. */
export async function deleteRemoteTag(repoPath: string, remote: string, name: string, opts: TagNetworkOptions = {}): Promise<void> {
  assertValidRemoteName(remote)
  await assertValidTagName(repoPath, name)
  await runGit(['push', '--no-progress', remote, `:refs/tags/${name}`], await networkRunOptions(repoPath, opts)).catch(
    (e: unknown) => pushError(e, name),
  )
}

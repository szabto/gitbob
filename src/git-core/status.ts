import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BranchStatus, StatusCode, StatusEntry, WorkingTreeStatus } from '@shared/types'
import { runGit } from './runner'

const STATUS_CODES = new Set<string>(['.', 'M', 'T', 'A', 'D', 'R', 'C', 'U', '?', '!'])

function code(c: string | undefined): StatusCode {
  return c !== undefined && STATUS_CODES.has(c) ? (c as StatusCode) : '.'
}

/** Split off the first `n` space-separated fields; the remainder (which may contain spaces) is returned last. */
function fields(line: string, n: number): string[] {
  const out: string[] = []
  let pos = 0
  for (let i = 0; i < n; i++) {
    const next = line.indexOf(' ', pos)
    if (next === -1) {
      out.push(line.slice(pos))
      pos = line.length
      break
    }
    out.push(line.slice(pos, next))
    pos = next + 1
  }
  out.push(line.slice(pos))
  return out
}

/** Parse `git status --porcelain=v2 -z --branch` output. */
export function parseStatusV2(stdout: string): { branch: BranchStatus; entries: StatusEntry[] } {
  const branch: BranchStatus = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 }
  const entries: StatusEntry[] = []
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i++]
    if (!tok) continue
    if (tok.startsWith('# ')) {
      const [, key = '', value = ''] = fields(tok, 2)
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') branch.upstream = value || null
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          branch.ahead = Number(m[1])
          branch.behind = Number(m[2])
        }
      }
      continue
    }
    const type = tok[0]
    if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const f = fields(tok, 8)
      const xy = f[1] ?? '..'
      entries.push({
        path: f[8] ?? '',
        index: code(xy[0]),
        worktree: code(xy[1]),
        kind: 'ordinary',
        submodule: (f[2] ?? '').startsWith('S'),
      })
    } else if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const f = fields(tok, 9)
      const xy = f[1] ?? '..'
      const origPath = tokens[i++] ?? ''
      entries.push({
        path: f[9] ?? '',
        origPath,
        index: code(xy[0]),
        worktree: code(xy[1]),
        kind: 'renamed',
        submodule: (f[2] ?? '').startsWith('S'),
      })
    } else if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const f = fields(tok, 10)
      const xy = f[1] ?? 'UU'
      entries.push({
        path: f[10] ?? '',
        index: code(xy[0]),
        worktree: code(xy[1]),
        kind: 'unmerged',
        submodule: (f[2] ?? '').startsWith('S'),
      })
    } else if (type === '?' || type === '!') {
      entries.push({
        path: tok.slice(2),
        index: type,
        worktree: type,
        kind: type === '?' ? 'untracked' : 'ignored',
        submodule: false,
      })
    }
  }
  return { branch, entries }
}

/** Run porcelain v2 status. `paths` (optional) limits the output; they are matched literally. */
export async function runStatus(
  repoPath: string,
  opts: { paths?: readonly string[]; renames?: boolean } = {},
): Promise<{ branch: BranchStatus; entries: StatusEntry[] }> {
  const args = [
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--untracked-files=all',
    opts.renames === false ? '--no-renames' : '--renames',
  ]
  if (opts.paths) args.push('--', ...opts.paths)
  const { stdout } = await runGit(args, {
    cwd: repoPath,
    // Don't take the index lock for the opportunistic index refresh; status must not
    // conflict with concurrent git processes (the user's terminal, editors).
    env: { GIT_OPTIONAL_LOCKS: '0', ...(opts.paths ? { GIT_LITERAL_PATHSPECS: '1' } : {}) },
  })
  return parseStatusV2(stdout)
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const OPERATION_MARKERS = ['rebase-merge', 'rebase-apply', 'rebase-apply/applying', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'] as const

/** Detect an in-progress merge/rebase/cherry-pick/revert/bisect from the git directory. */
export async function getOperation(repoPath: string): Promise<WorkingTreeStatus['operation']> {
  const args = ['rev-parse']
  for (const m of OPERATION_MARKERS) args.push('--git-path', m)
  const { stdout } = await runGit(args, { cwd: repoPath })
  const paths = stdout.split('\n').slice(0, OPERATION_MARKERS.length)
  const present = await Promise.all(paths.map((p) => exists(resolve(repoPath, p.trim()))))
  const has = (m: (typeof OPERATION_MARKERS)[number]): boolean => present[OPERATION_MARKERS.indexOf(m)] === true

  if (has('rebase-merge')) return 'rebase'
  // rebase-apply is shared with `git am`; the `applying` marker identifies am.
  if (has('rebase-apply') && !has('rebase-apply/applying')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  if (has('BISECT_LOG')) return 'bisect'
  return null
}

export async function getStatus(repoPath: string): Promise<WorkingTreeStatus> {
  const [{ branch, entries }, operation] = await Promise.all([runStatus(repoPath), getOperation(repoPath)])
  return { branch, entries, operation }
}

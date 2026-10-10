import type { StatusCode, StatusEntry, WorkingTreeStatus } from '@shared/types'

export interface StatusGroups {
  unstaged: StatusEntry[]
  staged: StatusEntry[]
  conflicted: StatusEntry[]
}

export function groupStatus(status: WorkingTreeStatus | undefined): StatusGroups {
  const groups: StatusGroups = { unstaged: [], staged: [], conflicted: [] }
  for (const e of status?.entries ?? []) {
    if (e.kind === 'ignored') continue
    if (e.kind === 'unmerged') {
      groups.conflicted.push(e)
      continue
    }
    if (e.kind === 'untracked' || e.worktree !== '.') groups.unstaged.push(e)
    if (e.kind !== 'untracked' && e.index !== '.') groups.staged.push(e)
  }
  return groups
}

export function statusBadge(code: StatusCode): { label: string; cls: string; title: string } {
  switch (code) {
    case 'A':
      return { label: 'A', cls: 'text-ok', title: 'Added' }
    case '?':
      return { label: 'N', cls: 'text-ok', title: 'Untracked (new)' }
    case 'M':
      return { label: 'M', cls: 'text-warn', title: 'Modified' }
    case 'D':
      return { label: 'D', cls: 'text-err', title: 'Deleted' }
    case 'R':
      return { label: 'R', cls: 'text-info', title: 'Renamed' }
    case 'C':
      return { label: 'C', cls: 'text-info', title: 'Copied' }
    case 'T':
      return { label: 'T', cls: 'text-purple', title: 'Type changed' }
    case 'U':
      return { label: 'U', cls: 'text-err', title: 'Conflicted' }
    default:
      return { label: '·', cls: 'text-muted', title: 'Unmodified' }
  }
}

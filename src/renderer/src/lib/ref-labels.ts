import type { GitRef } from '@shared/types'

/**
 * One label in the graph's Branch / Tag column. A local branch and same-named remote branches that
 * point to the same commit share one label (shown with a laptop icon and the remotes' icons);
 * when they differ, each sits on its own commit.
 */
export interface RefLabel {
  key: string
  /** Branch name without the remote prefix, or the tag name. */
  name: string
  kind: 'branch' | 'tag' | 'other'
  /** The local branch, if this label includes one. */
  local?: GitRef
  /** Remote-tracking branches in this label (`origin`, `upstream`, …). */
  remotes: { remote: string; ref: GitRef }[]
  tag?: GitRef
  /** Checked out (HEAD points to the local branch). */
  current: boolean
  /** The ref to drag / use for actions: the local branch if any, else the first remote one. */
  primary: GitRef
}

function splitRemote(ref: GitRef): { remote: string; branch: string } | null {
  const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref.name)
  return m ? { remote: m[1]!, branch: m[2]! } : null
}

/** Labels per commit sha, current branch first, then local, remote-only and tags. */
export function buildRefLabels(refs: readonly GitRef[], currentRef: string | null): Map<string, RefLabel[]> {
  const out = new Map<string, RefLabel[]>()
  const add = (sha: string, l: RefLabel): void => {
    const list = out.get(sha)
    if (list) list.push(l)
    else out.set(sha, [l])
  }
  const used = new Set<string>()
  const remotes = refs.filter((r) => r.kind === 'remote' && !r.name.endsWith('/HEAD'))

  for (const local of refs.filter((r) => r.kind === 'head')) {
    const branch = local.name.replace(/^refs\/heads\//, '')
    // The upstream, plus any remote's branch of the same name, merged when on the same commit.
    const same = remotes.filter((r) => {
      if (r.target !== local.target) return false
      const s = splitRemote(r)
      return r.name === local.upstream || s?.branch === branch
    })
    same.forEach((r) => used.add(r.name))
    add(local.target, {
      key: local.name,
      name: branch,
      kind: 'branch',
      local,
      remotes: same.map((ref) => ({ remote: splitRemote(ref)!.remote, ref })),
      current: local.name === currentRef,
      primary: local,
    })
  }

  // Remote-only labels, grouped by branch name and commit.
  const groups = new Map<string, { sha: string; branch: string; refs: GitRef[] }>()
  for (const r of remotes) {
    if (used.has(r.name)) continue
    const s = splitRemote(r)
    if (!s) continue
    const k = `${r.target}\0${s.branch}`
    const g = groups.get(k)
    if (g) g.refs.push(r)
    else groups.set(k, { sha: r.target, branch: s.branch, refs: [r] })
  }
  for (const g of groups.values()) {
    add(g.sha, {
      key: g.refs.map((r) => r.name).join('|'),
      name: g.branch,
      kind: 'branch',
      remotes: g.refs.map((ref) => ({ remote: splitRemote(ref)!.remote, ref })),
      current: false,
      primary: g.refs[0]!,
    })
  }

  for (const t of refs.filter((r) => r.kind === 'tag')) {
    add(t.target, { key: t.name, name: t.shortName, kind: 'tag', tag: t, remotes: [], current: false, primary: t })
  }
  for (const o of refs.filter((r) => r.kind === 'other' || r.kind === 'stash')) {
    if (o.kind === 'stash') continue
    add(o.target, { key: o.name, name: o.shortName, kind: 'other', remotes: [], current: false, primary: o })
  }

  const rank = (l: RefLabel): number => (l.current ? 0 : l.local ? 1 : l.kind === 'branch' ? 2 : l.kind === 'tag' ? 3 : 4)
  for (const list of out.values()) list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  return out
}

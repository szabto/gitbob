import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { FileChange } from '@shared/types'
import { call } from '../lib/api'
import { useAppStore } from '../state/store'
import { useUiStore } from '../state/ui'

const statusLabel: Record<FileChange['status'], { label: string; cls: string }> = {
  A: { label: 'A', cls: 'text-ok' },
  M: { label: 'M', cls: 'text-warn' },
  D: { label: 'D', cls: 'text-err' },
  R: { label: 'R', cls: 'text-info' },
  C: { label: 'C', cls: 'text-info' },
  T: { label: 'T', cls: 'text-purple' },
  U: { label: 'U', cls: 'text-err' },
  X: { label: '?', cls: 'text-muted' },
}

const MODE_KEY = 'gitbob.commitFilesMode'
type Mode = 'path' | 'tree'
function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'tree' ? 'tree' : 'path'
  } catch {
    return 'path'
  }
}

/** One entry to show: a changed file, or (with "View all files") an unchanged one. */
interface Entry {
  path: string
  change?: FileChange
}

interface TreeNode {
  name: string
  path: string
  dirs: Map<string, TreeNode>
  files: Entry[]
}

function buildTree(entries: Entry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const e of entries) {
    const parts = e.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part)
      if (!next) node.dirs.set(part, (next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] }))
      node = next
    }
    node.files.push(e)
  }
  return root
}

/** Collapse chains of single folders ("src/main") like most file trees do. */
function compact(node: TreeNode): TreeNode {
  for (const [k, d] of node.dirs) node.dirs.set(k, compact(d))
  if (node.path && node.files.length === 0 && node.dirs.size === 1) {
    const only = [...node.dirs.values()][0]!
    return { ...only, name: `${node.name}/${only.name}` }
  }
  return node
}

/**
 * Changed files of a commit as a path list or a folder tree, optionally with every file in it.
 * With `range`, the files changed between two commits (several selected commits combined).
 */
export function CommitFiles({
  repoPath,
  sha,
  files,
  isMerge = false,
  range,
}: {
  repoPath: string
  sha: string
  files: FileChange[]
  isMerge?: boolean
  range?: { base: string; head: string }
}) {
  const [mode, setModeState] = useState<Mode>(loadMode)
  const [allFiles, setAllFiles] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const showDiff = useAppStore((s) => s.showDiff)
  const diffTarget = useAppStore((s) => s.diffTarget)
  const openFileHistory = useAppStore((s) => s.openFileHistory)
  const openBlame = useAppStore((s) => s.openBlame)
  const tree = useQuery({ queryKey: ['commit-all-files', repoPath, sha], queryFn: () => call('commit:all-files', { repoPath, sha }), enabled: allFiles, staleTime: Infinity })

  const setMode = (m: Mode): void => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* per-viewer convenience */
    }
  }

  const entries = useMemo<Entry[]>(() => {
    const changed: Entry[] = files.map((f) => ({ path: f.path, change: f }))
    if (!allFiles || !tree.data) return changed
    const seen = new Set(files.map((f) => f.path))
    return [...changed, ...tree.data.paths.filter((p) => !seen.has(p)).map((path) => ({ path }))].sort((a, b) => a.path.localeCompare(b.path))
  }, [files, allFiles, tree.data])

  const open = (e: Entry): void => {
    const oldPath = e.change?.oldPath ? { oldPath: e.change.oldPath } : {}
    if (e.change && range) showDiff({ kind: 'range', base: range.base, head: range.head, path: e.path, ...oldPath })
    else if (e.change) showDiff({ kind: 'commit', sha, path: e.path, ...oldPath })
    else openBlame({ path: e.path, rev: sha })
  }
  const menu = (ev: React.MouseEvent, e: Entry): void => {
    ev.preventDefault()
    useUiStore.getState().openMenu(ev.clientX, ev.clientY, [
      { label: 'File history', onSelect: () => openFileHistory(e.path) },
      ...(e.change?.status === 'D' || range ? [] : [{ label: 'Blame', onSelect: () => openBlame({ path: e.path, rev: sha }) }]),
    ])
  }

  const fileRow = (e: Entry, depth: number, nameOnly: boolean) => {
    const f = e.change
    const active =
      !!f &&
      diffTarget?.path === e.path &&
      (range ? diffTarget.kind === 'range' && diffTarget.base === range.base && diffTarget.head === range.head : diffTarget.kind === 'commit' && diffTarget.sha === sha)
    const slash = e.path.lastIndexOf('/')
    const dir = slash >= 0 ? e.path.slice(0, slash + 1) : ''
    const name = e.path.slice(slash + 1)
    return (
      <li
        key={e.path}
        data-testid="details-file"
        data-path={e.path}
        data-changed={f ? 'true' : undefined}
        onClick={() => open(e)}
        onContextMenu={(ev) => menu(ev, e)}
        style={{ paddingLeft: 4 + depth * 12 }}
        className={`-mx-1 flex cursor-default items-center gap-2 rounded py-0.5 pr-1 ${active ? 'bg-accent/20' : 'hover:bg-fg/[0.05]'} ${f ? '' : 'opacity-60'}`}
      >
        <span className={`w-3 shrink-0 font-bold ${f ? statusLabel[f.status].cls : ''}`}>{f ? statusLabel[f.status].label : ''}</span>
        <span className="min-w-0 flex-1 truncate" title={f?.oldPath ? `${f.oldPath} → ${e.path}` : e.path}>
          {f?.oldPath && !nameOnly ? <span className="text-muted">{f.oldPath} → </span> : null}
          {!nameOnly && dir && <span className="text-muted">{dir}</span>}
          <span className="text-fg">{name}</span>
        </span>
        {f &&
          (f.additions === null ? (
            <span className="text-muted">bin</span>
          ) : (
            <span className="shrink-0">
              <span className="text-ok">+{f.additions}</span> <span className="text-err">-{f.deletions}</span>
            </span>
          ))}
      </li>
    )
  }

  const renderTree = (node: TreeNode, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = []
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const isCollapsed = collapsed.has(d.path)
      out.push(
        <li
          key={`dir:${d.path}`}
          data-testid="details-folder"
          data-folder={d.path}
          style={{ paddingLeft: 4 + depth * 12 }}
          className="-mx-1 flex cursor-default items-center gap-1 rounded py-0.5 text-muted hover:bg-fg/[0.05]"
          onClick={() =>
            setCollapsed((s) => {
              const n = new Set(s)
              if (n.has(d.path)) n.delete(d.path)
              else n.add(d.path)
              return n
            })
          }
        >
          <span className="w-3 text-[10px]">{isCollapsed ? '▸' : '▾'}</span>
          <span className="truncate">{d.name}/</span>
        </li>,
      )
      if (!isCollapsed) out.push(...renderTree(d, depth + 1))
    }
    for (const f of node.files) out.push(fileRow(f, depth, true))
    return out
  }

  return (
    <div>
      <h3 className="mt-5 text-xs font-semibold tracking-wider text-muted uppercase">
        {files.length} file{files.length === 1 ? '' : 's'} changed
        {isMerge && <span className="font-normal tracking-normal normal-case"> (vs first parent)</span>}
      </h3>
      <div className="mt-1 mb-1 flex items-center gap-2 text-xs">
        <div className="flex overflow-hidden rounded border border-border" role="group" aria-label="File list layout">
          {(['path', 'tree'] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className={`px-1.5 py-0.5 ${mode === m ? 'bg-accent/20 text-fg' : 'text-muted hover:bg-panel-2'}`}>
              {m === 'path' ? 'Path' : 'Tree'}
            </button>
          ))}
        </div>
        {!range && (
          <label className="flex items-center gap-1 text-muted" title="Also list files this commit didn't change">
            <input type="checkbox" checked={allFiles} onChange={(e) => setAllFiles(e.target.checked)} />
            All files
          </label>
        )}
      </div>
      {allFiles && tree.data?.truncated && <p className="text-xs text-warn">Showing the first 50,000 files.</p>}
      <ul data-testid="details-files" className="font-mono text-xs">
        {mode === 'path' ? entries.map((e) => fileRow(e, 0, false)) : renderTree(compact(buildTree(entries)), 0)}
      </ul>
    </div>
  )
}

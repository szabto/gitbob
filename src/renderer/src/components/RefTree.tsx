import { useState } from 'react'
import type { GitRef } from '@shared/types'

interface Folder {
  name: string
  path: string
  folders: Map<string, Folder>
  refs: GitRef[]
}

/** Group refs by the "/" segments of their name: feature/login → feature › login. */
export function buildRefTree(refs: GitRef[], nameOf: (r: GitRef) => string): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), refs: [] }
  for (const r of refs) {
    const parts = nameOf(r).split('/')
    parts.pop()
    let node = root
    for (const part of parts) {
      let next = node.folders.get(part)
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: new Map(), refs: [] }
        node.folders.set(part, next)
      }
      node = next
    }
    node.refs.push(r)
  }
  return root
}

function countRefs(f: Folder): number {
  let n = f.refs.length
  for (const c of f.folders.values()) n += countRefs(c)
  return n
}

const STORAGE_KEY = 'gitbob.collapsedRefFolders'

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Collapsible tree of refs. `scope` keeps collapse state separate per section
 * (e.g. "local", "remote:origin"); folders containing the active ref always open.
 */
export function RefTree({
  refs,
  scope,
  nameOf = (r) => r.shortName,
  activeRef,
  depth = 0,
  renderRef,
}: {
  refs: GitRef[]
  scope: string
  nameOf?: (r: GitRef) => string
  activeRef?: string | null
  depth?: number
  renderRef: (r: GitRef, label: string, depth: number) => React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        /* per-viewer convenience only */
      }
      return next
    })
  }
  const tree = buildRefTree(refs, nameOf)
  const label = (r: GitRef): string => nameOf(r).split('/').pop() ?? nameOf(r)

  const render = (f: Folder, d: number): React.ReactNode[] => {
    const out: React.ReactNode[] = []
    const folders = [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const sub of folders) {
      const key = `${scope}:${sub.path}`
      const containsActive = !!activeRef && hasRef(sub, activeRef)
      const open = containsActive || !collapsed.has(key)
      out.push(
        <li key={`folder:${key}`}>
          <button
            data-testid="ref-folder"
            data-folder={sub.path}
            aria-expanded={open}
            onClick={() => toggle(key)}
            className="flex w-full items-center gap-1.5 py-0.5 pr-3 text-left text-muted hover:bg-panel-2 hover:text-fg"
            style={{ paddingLeft: 12 + d * 12 }}
          >
            <span className="inline-block w-3 text-[10px]">{open ? '▾' : '▸'}</span>
            <span aria-hidden>📁</span>
            <span className="truncate">{sub.name}</span>
            <span className="ml-auto text-[10px]">{countRefs(sub)}</span>
          </button>
        </li>,
      )
      if (open) out.push(...render(sub, d + 1))
    }
    for (const r of [...f.refs].sort((a, b) => label(a).localeCompare(label(b)))) out.push(renderRef(r, label(r), d))
    return out
  }

  return <>{render(tree, depth)}</>
}

function hasRef(f: Folder, name: string): boolean {
  return f.refs.some((r) => r.name === name) || [...f.folders.values()].some((c) => hasRef(c, name))
}

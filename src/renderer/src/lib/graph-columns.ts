import { useCallback, useState } from 'react'

export interface GraphColumns {
  refs: number
  author: number
  date: number
  sha: number
  show: { refs: boolean; author: boolean; date: boolean; sha: boolean }
}

const KEY = 'gitbob.graphColumns'
export const DEFAULT_COLUMNS: GraphColumns = { refs: 180, author: 150, date: 110, sha: 80, show: { refs: true, author: true, date: true, sha: true } }
const clamp = (n: unknown, d: number): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(600, Math.max(48, Math.round(n))) : d)

function load(): GraphColumns {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<GraphColumns> | null
    if (!v || typeof v !== 'object') return DEFAULT_COLUMNS
    const show = { ...DEFAULT_COLUMNS.show, ...(v.show && typeof v.show === 'object' ? v.show : {}) }
    return {
      refs: clamp(v.refs, DEFAULT_COLUMNS.refs),
      author: clamp(v.author, DEFAULT_COLUMNS.author),
      date: clamp(v.date, DEFAULT_COLUMNS.date),
      sha: clamp(v.sha, DEFAULT_COLUMNS.sha),
      show: { refs: show.refs !== false, author: show.author !== false, date: show.date !== false, sha: show.sha !== false },
    }
  } catch {
    return DEFAULT_COLUMNS
  }
}

/** Graph column widths and visibility, remembered per profile (localStorage). */
export function useGraphColumns(): [GraphColumns, (update: (c: GraphColumns) => GraphColumns) => void] {
  const [cols, setCols] = useState(load)
  const update = useCallback((fn: (c: GraphColumns) => GraphColumns) => {
    setCols((prev) => {
      const next = fn(prev)
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* per-viewer convenience */
      }
      return next
    })
  }, [])
  return [cols, update]
}

export function clampWidth(n: number): number {
  return clamp(n, 120)
}

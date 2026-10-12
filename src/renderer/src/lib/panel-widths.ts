import { useCallback, useSyncExternalStore } from 'react'

export type Pane = 'sidebar' | 'details'

/** Default, minimum and maximum widths (px) of the side panes. */
export const PANE_LIMITS: Record<Pane, { def: number; min: number; max: number }> = {
  sidebar: { def: 240, min: 160, max: 560 },
  details: { def: 380, min: 280, max: 900 },
}

const KEY = 'gitbob.paneWidths'

export function clampPane(pane: Pane, n: unknown): number {
  const { def, min, max } = PANE_LIMITS[pane]
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def
}

export function parsePaneWidths(raw: string | null): Record<Pane, number> {
  let v: Partial<Record<Pane, unknown>> = {}
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null')
    if (parsed && typeof parsed === 'object') v = parsed as Partial<Record<Pane, unknown>>
  } catch {
    /* fall back to defaults */
  }
  return { sidebar: clampPane('sidebar', v.sidebar), details: clampPane('details', v.details) }
}

let widths: Record<Pane, number> | null = null
const listeners = new Set<() => void>()

function current(): Record<Pane, number> {
  if (!widths) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(KEY)
    } catch {
      /* per-viewer convenience */
    }
    widths = parsePaneWidths(raw)
  }
  return widths
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Width of a side pane, shared by every panel that occupies it (commit details, staging, stash)
 * and remembered per profile (localStorage). Pass `null` to restore the default.
 */
export function usePaneWidth(pane: Pane): [number, (width: number | null) => void] {
  const width = useSyncExternalStore(subscribe, () => current()[pane])
  const set = useCallback(
    (w: number | null) => {
      widths = { ...current(), [pane]: w === null ? PANE_LIMITS[pane].def : clampPane(pane, w) }
      try {
        localStorage.setItem(KEY, JSON.stringify(widths))
      } catch {
        /* per-viewer convenience */
      }
      listeners.forEach((l) => l())
    },
    [pane],
  )
  return [width, set]
}

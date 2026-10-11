import { create } from 'zustand'

const KEY = 'gitbob.hiddenRefs'

function load(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, list]) => [k, Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 1000) : []]),
    )
  } catch {
    return {}
  }
}

function save(data: Record<string, string[]>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    /* per-viewer convenience */
  }
}

interface HiddenState {
  byRepo: Record<string, string[]>
  toggle: (repoPath: string, ref: string) => void
  showAll: (repoPath: string) => void
}

const EMPTY: string[] = []

/** Branches and tags hidden from the graph, per repository (remembered per profile). */
export const useHiddenStore = create<HiddenState>((set, get) => ({
  byRepo: load(),
  toggle: (repoPath, ref) => {
    const cur = get().byRepo[repoPath] ?? []
    const next = cur.includes(ref) ? cur.filter((r) => r !== ref) : [...cur, ref]
    const byRepo = { ...get().byRepo, [repoPath]: next }
    if (!next.length) delete byRepo[repoPath]
    save(byRepo)
    set({ byRepo })
  },
  showAll: (repoPath) => {
    const byRepo = { ...get().byRepo }
    delete byRepo[repoPath]
    save(byRepo)
    set({ byRepo })
  },
}))

export const useHiddenRefs = (repoPath: string): string[] => useHiddenStore((s) => s.byRepo[repoPath] ?? EMPTY)

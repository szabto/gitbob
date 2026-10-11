import { create } from 'zustand'
import type { DiffTarget, HistoryFilter, RepositoryInfo } from '@shared/types'

interface AppState {
  /** Open repositories, one per tab. */
  tabs: RepositoryInfo[]
  /** The active tab's repository; null shows the start screen (e.g. a new, empty tab). */
  repo: RepositoryInfo | null
  /** Show the start screen in a new tab without closing the others. */
  newTab: () => void
  closeTab: (root: string) => void
  selectedSha: string | null
  /** True when the working-tree (WIP) entry is selected instead of a commit. */
  wipSelected: boolean
  /** Commit the graph should scroll into view (set by sidebar navigation). */
  revealSha: string | null
  /** File diff shown in the main area instead of the graph. */
  diffTarget: DiffTarget | null
  /** Pull request shown in the main area. */
  prNumber: number | null
  openPr: (n: number | null) => void
  /** Active graph filter (branch/author/path); null shows everything. */
  historyFilter: HistoryFilter | null
  setHistoryFilter: (filter: HistoryFilter | null) => void
  /** Commit compared with the working directory (replaces the graph). */
  compareSha: string | null
  openCompare: (sha: string | null) => void
  /** File whose history is shown (replaces the graph). */
  fileHistory: string | null
  openFileHistory: (path: string | null) => void
  /** File shown in the blame view (replaces the graph). */
  blame: { path: string; rev?: string } | null
  openBlame: (blame: { path: string; rev?: string } | null) => void
  /** Commit chosen as the base of an interactive rebase (dialog open while set). */
  rebaseBase: string | null
  openRebase: (base: string | null) => void
  /** Conflicted file open in the conflict editor (replaces the graph). */
  conflictPath: string | null
  openConflict: (path: string | null) => void
  /** Stash shown in the right panel. */
  selectedStash: { index: number; sha: string } | null
  selectStash: (stash: { index: number; sha: string } | null) => void
  setRepo: (repo: RepositoryInfo | null) => void
  select: (sha: string | null) => void
  selectWip: () => void
  reveal: (sha: string) => void
  clearReveal: () => void
  showDiff: (target: DiffTarget | null) => void
}

const RESET = {
  selectedSha: null,
  wipSelected: false,
  revealSha: null,
  diffTarget: null,
  selectedStash: null,
  conflictPath: null,
  blame: null,
  fileHistory: null,
  compareSha: null,
  rebaseBase: null,
  historyFilter: null,
  prNumber: null,
} as const

export const useAppStore = create<AppState>((set, get) => ({
  tabs: [],
  repo: null,
  selectedSha: null,
  wipSelected: false,
  revealSha: null,
  diffTarget: null,
  selectedStash: null,
  conflictPath: null,
  prNumber: null,
  openPr: (prNumber) => set({ prNumber, diffTarget: null, blame: null, conflictPath: null, fileHistory: null }),
  fileHistory: null,
  openFileHistory: (fileHistory) => set({ fileHistory, compareSha: null, diffTarget: null, blame: null, conflictPath: null }),
  compareSha: null,
  openCompare: (compareSha) => set({ compareSha, fileHistory: null, diffTarget: null, blame: null, conflictPath: null }),
  historyFilter: null,
  setHistoryFilter: (historyFilter) => set({ historyFilter, selectedSha: null }),
  blame: null,
  openBlame: (blame) => set({ blame, diffTarget: null, conflictPath: null, fileHistory: null, compareSha: null }),
  rebaseBase: null,
  openRebase: (rebaseBase) => set({ rebaseBase }),
  openConflict: (conflictPath) => set({ conflictPath, diffTarget: null, blame: null, fileHistory: null, compareSha: null }),
  setRepo: (repo) => {
    if (!repo) {
      // "Close": close the active tab.
      const cur = get().repo
      if (cur) get().closeTab(cur.root)
      return
    }
    const tabs = get().tabs
    set({
      ...RESET,
      repo,
      tabs: tabs.some((t) => t.root === repo.root) ? tabs.map((t) => (t.root === repo.root ? repo : t)) : [...tabs, repo],
    })
  },
  newTab: () => set({ ...RESET, repo: null }),
  closeTab: (root) => {
    const { tabs, repo } = get()
    const idx = tabs.findIndex((t) => t.root === root)
    const next = tabs.filter((t) => t.root !== root)
    if (repo?.root === root) {
      set({ ...RESET, tabs: next, repo: next[Math.min(idx, next.length - 1)] ?? null })
    } else {
      set({ tabs: next })
    }
  },
  select: (sha) => set({ selectedSha: sha, wipSelected: false, diffTarget: null, selectedStash: null }),
  selectWip: () => set({ selectedSha: null, wipSelected: true, diffTarget: null, selectedStash: null }),
  selectStash: (stash) => set({ selectedStash: stash, selectedSha: null, wipSelected: false, diffTarget: null }),
  reveal: (sha) => set({ selectedSha: sha, wipSelected: false, revealSha: sha, diffTarget: null, selectedStash: null, fileHistory: null, compareSha: null, blame: null }),
  clearReveal: () => set({ revealSha: null }),
  showDiff: (target) => set({ diffTarget: target, conflictPath: null, blame: null, fileHistory: null, compareSha: null }),
}))

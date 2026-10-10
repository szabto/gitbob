import { create } from 'zustand'
import type { DiffTarget, RepositoryInfo } from '@shared/types'

interface AppState {
  repo: RepositoryInfo | null
  selectedSha: string | null
  /** True when the working-tree (WIP) entry is selected instead of a commit. */
  wipSelected: boolean
  /** Commit the graph should scroll into view (set by sidebar navigation). */
  revealSha: string | null
  /** File diff shown in the main area instead of the graph. */
  diffTarget: DiffTarget | null
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

export const useAppStore = create<AppState>((set) => ({
  repo: null,
  selectedSha: null,
  wipSelected: false,
  revealSha: null,
  diffTarget: null,
  selectedStash: null,
  conflictPath: null,
  openConflict: (conflictPath) => set({ conflictPath, diffTarget: null }),
  setRepo: (repo) =>
    set({ repo, selectedSha: null, wipSelected: false, revealSha: null, diffTarget: null, selectedStash: null, conflictPath: null }),
  select: (sha) => set({ selectedSha: sha, wipSelected: false, diffTarget: null, selectedStash: null }),
  selectWip: () => set({ selectedSha: null, wipSelected: true, diffTarget: null, selectedStash: null }),
  selectStash: (stash) => set({ selectedStash: stash, selectedSha: null, wipSelected: false, diffTarget: null }),
  reveal: (sha) => set({ selectedSha: sha, wipSelected: false, revealSha: sha, diffTarget: null, selectedStash: null }),
  clearReveal: () => set({ revealSha: null }),
  showDiff: (target) => set({ diffTarget: target, conflictPath: null }),
}))

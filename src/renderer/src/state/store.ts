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

export const useAppStore = create<AppState>((set) => ({
  repo: null,
  selectedSha: null,
  wipSelected: false,
  revealSha: null,
  diffTarget: null,
  selectedStash: null,
  conflictPath: null,
  blame: null,
  openBlame: (blame) => set({ blame, diffTarget: null, conflictPath: null }),
  rebaseBase: null,
  openRebase: (rebaseBase) => set({ rebaseBase }),
  openConflict: (conflictPath) => set({ conflictPath, diffTarget: null, blame: null }),
  setRepo: (repo) =>
    set({ repo, selectedSha: null, wipSelected: false, revealSha: null, diffTarget: null, selectedStash: null, conflictPath: null, blame: null, rebaseBase: null }),
  select: (sha) => set({ selectedSha: sha, wipSelected: false, diffTarget: null, selectedStash: null }),
  selectWip: () => set({ selectedSha: null, wipSelected: true, diffTarget: null, selectedStash: null }),
  selectStash: (stash) => set({ selectedStash: stash, selectedSha: null, wipSelected: false, diffTarget: null }),
  reveal: (sha) => set({ selectedSha: sha, wipSelected: false, revealSha: sha, diffTarget: null, selectedStash: null }),
  clearReveal: () => set({ revealSha: null }),
  showDiff: (target) => set({ diffTarget: target, conflictPath: null, blame: null }),
}))

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
  setRepo: (repo) => set({ repo, selectedSha: null, wipSelected: false, revealSha: null, diffTarget: null }),
  select: (sha) => set({ selectedSha: sha, wipSelected: false, diffTarget: null }),
  selectWip: () => set({ selectedSha: null, wipSelected: true, diffTarget: null }),
  reveal: (sha) => set({ selectedSha: sha, wipSelected: false, revealSha: sha, diffTarget: null }),
  clearReveal: () => set({ revealSha: null }),
  showDiff: (target) => set({ diffTarget: target }),
}))

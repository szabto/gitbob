import { create } from 'zustand'
import { ApiError } from '../lib/api'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}
export type MenuEntry = MenuItem | 'separator'

export interface PromptOptions {
  title: string
  label: string
  initialValue?: string
  confirmLabel?: string
  placeholder?: string
  /** Optional choices rendered as a select instead of a text input. */
  choices?: string[]
  /** Allow submitting an empty value (resolves to ''). */
  allowEmpty?: boolean
  /** Render a multi-line text area. */
  multiline?: boolean
  /** Mask the input (tokens, passwords). */
  secret?: boolean
  /** Extra explanation under the field. */
  help?: string
}

interface UiState {
  error: ApiError | null
  /** Informational message (e.g. where a backup was saved). */
  notice: string | null
  /** The latest notice, kept for the status bar after the banner is dismissed. */
  lastMessage: { text: string; at: number } | null
  showNotice: (message: string | null) => void
  menu: { x: number; y: number; items: MenuEntry[] } | null
  prompt: (PromptOptions & { resolve: (value: string | null) => void }) | null
  /** Label of the currently running long operation (fetch/pull/push), if any. */
  busy: string | null
  /** Preferred diff presentation (remembered per viewer). */
  diffMode: 'unified' | 'split'
  setDiffMode: (mode: 'unified' | 'split') => void
  progress: { phase: string; percent: number } | null
  setProgress: (p: { phase: string; percent: number } | null) => void
  showError: (err: unknown) => void
  clearError: () => void
  openMenu: (x: number, y: number, items: MenuEntry[]) => void
  closeMenu: () => void
  ask: (opts: PromptOptions) => Promise<string | null>
  closePrompt: (value: string | null) => void
  setBusy: (label: string | null) => void
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  return new ApiError({ code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) })
}

export const useUiStore = create<UiState>((set, get) => ({
  error: null,
  notice: null,
  lastMessage: null,
  showNotice: (notice) => set(notice ? { notice, lastMessage: { text: notice, at: Date.now() } } : { notice }),
  menu: null,
  prompt: null,
  busy: null,
  diffMode: readDiffMode(),
  setDiffMode: (diffMode) => {
    try {
      localStorage.setItem('gitbob.diffMode', diffMode)
    } catch {
      /* storage unavailable: keep in memory only */
    }
    set({ diffMode })
  },
  progress: null,
  setProgress: (progress) => set({ progress }),
  showError: (err) => set({ error: toApiError(err) }),
  clearError: () => set({ error: null }),
  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
  ask: (opts) =>
    new Promise((resolve) => {
      get().prompt?.resolve(null)
      set({ prompt: { ...opts, resolve } })
    }),
  closePrompt: (value) => {
    get().prompt?.resolve(value)
    set({ prompt: null })
  },
  setBusy: (busy) => set({ busy, progress: null }),
}))

function readDiffMode(): 'unified' | 'split' {
  try {
    return localStorage.getItem('gitbob.diffMode') === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

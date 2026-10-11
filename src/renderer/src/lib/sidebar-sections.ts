import { useState } from 'react'

const SECTIONS_KEY = 'gitbob.sidebarSections'
/** Sections start collapsed unless `defaultOpen` (Local, Pull requests, LFS); each remembers its state. */
export function useSectionOpen(id: string, defaultOpen = id === 'local-branches'): [boolean, (v: boolean) => void] {
  const read = (): boolean => {
    try {
      const v = (JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}') as Record<string, unknown>)[id]
      return typeof v === 'boolean' ? v : defaultOpen
    } catch {
      return defaultOpen
    }
  }
  const [open, setOpen] = useState(read)
  return [
    open,
    (v: boolean) => {
      setOpen(v)
      try {
        const all = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}') as Record<string, boolean>
        localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...all, [id]: v }))
      } catch {
        /* per-viewer convenience */
      }
    },
  ]
}

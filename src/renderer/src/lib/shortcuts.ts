/**
 * Accelerator strings like "Mod+Shift+F": modifiers (Mod = ⌘ on macOS, Ctrl elsewhere; Ctrl,
 * Alt, Shift, Meta) joined with "+", followed by a key (a letter/digit, F1–F12, Enter, Escape,
 * Up/Down/Left/Right, Backspace, Delete, Tab, Space, or a punctuation character).
 */
export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

const MODS = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const

function normKey(key: string): string {
  const map: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Esc: 'Escape' }
  if (map[key]) return map[key]!
  return key.length === 1 ? key.toUpperCase() : key
}

/** Accelerator for a keyboard event, or null for a bare modifier press. */
export function eventToAccelerator(e: KeyboardEvent | React.KeyboardEvent): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null
  const parts: string[] = []
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (mod) parts.push('Mod')
  if (isMac ? e.ctrlKey : e.metaKey) parts.push(isMac ? 'Ctrl' : 'Meta')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  // With Alt/Shift, e.key may be a different character; prefer the physical key for letters/digits.
  const code = (e as KeyboardEvent).code ?? ''
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : normKey(e.key)
  parts.push(key)
  return parts.join('+')
}

/** Canonical form so "shift+mod+f" equals "Mod+Shift+F". */
export function normalizeAccelerator(acc: string): string {
  const parts = acc.split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const mods = MODS.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()))
  return [...mods, normKey(key.length === 1 ? key.toUpperCase() : key)].join('+')
}

/** Human-readable label, e.g. "⇧⌘F" on macOS or "Ctrl+Shift+F" elsewhere. */
export function formatAccelerator(acc: string): string {
  const n = normalizeAccelerator(acc)
  if (!isMac) return n.replace('Mod', 'Ctrl')
  const sym: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Backspace: '⌫', Escape: '⎋' }
  const parts = n.split('+')
  const key = parts.pop()!
  const order = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta']
  return parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((p) => sym[p] ?? p).join('') + (sym[key] ?? key)
}

/** Shortcuts owned by the native menu; commands may not be rebound to these. */
export const RESERVED = ['Mod+O', 'Mod+Shift+O', 'Mod+Alt+N', 'Mod+K', 'Mod+,', 'Mod+Q', 'Mod+W', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+Z', 'Mod+Shift+Z', 'Mod+R'].map(normalizeAccelerator)

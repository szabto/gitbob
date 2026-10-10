import { useMemo, useState } from 'react'
import type { Command } from '../lib/commands'
import { formatAccelerator } from '../lib/shortcuts'
import { fuzzyScore } from '../lib/fuzzy'

export interface PaletteItem {
  id: string
  title: string
  section: string
  shortcut?: string
  disabled?: boolean
  run: () => void
}


/** ⌘K: run any command or check out a branch by typing part of its name. */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(
    () =>
      items
        .filter((i) => !i.disabled)
        .map((i) => ({ i, s: fuzzyScore(query, `${i.section} ${i.title}`) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map((r) => r.i),
    [items, query],
  )

  const run = (item: PaletteItem | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="w-[560px] max-w-[94vw] overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
          aria-label="Type a command"
          placeholder="Type a command or a branch name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(results[active])
            }
          }}
          className="w-full border-b border-border bg-bg px-4 py-3 text-sm outline-none"
        />
        <ul id="palette-results" role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && <li className="px-4 py-2 text-sm text-muted">No matching commands</li>}
          {results.map((r, idx) => (
            <li
              key={r.id}
              id={`palette-${r.id}`}
              role="option"
              aria-selected={idx === active}
              data-testid="palette-item"
              onMouseEnter={() => setActive(idx)}
              onClick={() => run(r)}
              className={`flex cursor-default items-center gap-3 px-4 py-1.5 text-sm ${idx === active ? 'bg-accent/20' : ''}`}
            >
              <span className="w-20 shrink-0 text-xs text-muted">{r.section}</span>
              <span className="flex-1 truncate">{r.title}</span>
              {r.shortcut && <kbd className="text-xs text-muted">{formatAccelerator(r.shortcut)}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function commandToItem(c: Command, shortcut: string | undefined): PaletteItem {
  return { id: c.id, title: c.title, section: c.section, ...(shortcut ? { shortcut } : {}), ...(c.disabled ? { disabled: true } : {}), run: c.run }
}

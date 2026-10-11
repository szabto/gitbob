import { useEffect, useRef, useState } from 'react'

export interface PickerItem {
  key: string
  label: string
  hint?: string
  group?: string
  current?: boolean
  onSelect: () => void
}

/**
 * A dropdown anchored under its button: a search box and a keyboard-navigable list, grouped.
 * `footer` items are always shown below the list (e.g. "Open…").
 */
export function Picker({
  label,
  buttonContent,
  testId,
  items,
  footer = [],
  placeholder,
}: {
  label: string
  buttonContent: React.ReactNode
  testId: string
  items: PickerItem[]
  footer?: PickerItem[]
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const q = query.trim().toLowerCase()
  const shown = (q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items).slice(0, 200)
  const all = [...shown, ...footer]
  const choose = (i: PickerItem): void => {
    setOpen(false)
    setQuery('')
    i.onSelect()
  }

  return (
    <div className="relative" ref={root}>
      <button
        data-testid={testId}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          setActive(0)
        }}
        className="flex max-w-64 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-panel-2"
      >
        {buttonContent}
        <span aria-hidden className="text-[10px] text-muted">
          ▾
        </span>
      </button>
      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 w-80 rounded-md border border-border bg-panel shadow-2xl" data-testid={`${testId}-menu`}>
          <input
            autoFocus
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, all.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter' && all[active]) choose(all[active]!)
            }}
            className="w-full rounded-t-md border-b border-border bg-bg px-2 py-1.5 text-sm outline-none"
          />
          <ul role="listbox" aria-label={label} className="max-h-80 overflow-y-auto py-1 text-sm">
            {shown.map((i, idx) => (
              <li key={i.key}>
                {(idx === 0 || shown[idx - 1]!.group !== i.group) && i.group && (
                  <div className="px-3 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{i.group}</div>
                )}
                <button
                  role="option"
                  aria-selected={idx === active}
                  data-testid="picker-item"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left ${idx === active ? 'bg-accent/15' : ''}`}
                >
                  <span className="w-3 shrink-0 text-accent">{i.current ? '●' : ''}</span>
                  <span className="truncate">{i.label}</span>
                  {i.hint && <span className="ml-auto truncate pl-2 text-xs text-muted">{i.hint}</span>}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-1.5 text-xs text-muted">No matches</li>}
          </ul>
          {footer.length > 0 && (
            <div className="border-t border-border py-1 text-sm">
              {footer.map((i, k) => (
                <button
                  key={i.key}
                  data-testid="picker-footer-item"
                  onMouseEnter={() => setActive(shown.length + k)}
                  onClick={() => choose(i)}
                  className={`flex w-full px-3 py-1 text-left ${shown.length + k === active ? 'bg-accent/15' : ''}`}
                >
                  {i.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

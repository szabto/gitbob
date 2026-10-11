import { useEffect, useRef, useState } from 'react'
import type { GitRef, HistoryFilter } from '@shared/types'
import { useAppStore } from '../state/store'

/** Filter the graph by branches/tags, author and path. */
export function GraphFilter({ refs }: { refs: GitRef[] }) {
  const filter = useAppStore((s) => s.historyFilter)
  const setFilter = useAppStore((s) => s.setHistoryFilter)
  const [open, setOpen] = useState(false)
  const popover = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!popover.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const summary = filter
    ? [
        filter.refs?.length ? filter.refs.map((r) => r.replace(/^refs\/(heads|remotes|tags)\//, '')).join(', ') : null,
        filter.author ? `author: ${filter.author}` : null,
        filter.path ? `path: ${filter.path}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null

  return (
    <div className="relative flex shrink-0 items-center gap-1 font-normal" ref={popover}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-testid="filter-button"
        className={`shrink-0 rounded border px-1.5 text-[11px] leading-4 ${
          filter ? 'border-accent text-accent' : 'border-border text-muted hover:text-fg'
        }`}
      >
        Filter{filter ? ' ●' : ''}
      </button>
      {summary && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-accent" data-testid="filter-summary">
          <span className="truncate">{summary}</span>
          <button aria-label="Clear filter" className="text-muted hover:text-fg" onClick={() => setFilter(null)}>
            ✕
          </button>
        </span>
      )}
      {open && <FilterForm refs={refs} initial={filter} onApply={(f) => (setFilter(f), setOpen(false))} />}
    </div>
  )
}

function FilterForm({
  refs,
  initial,
  onApply,
}: {
  refs: GitRef[]
  initial: HistoryFilter | null
  onApply: (f: HistoryFilter | null) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial?.refs ?? []))
  const [author, setAuthor] = useState(initial?.author ?? '')
  const [path, setPath] = useState(initial?.path ?? '')
  const [query, setQuery] = useState('')
  const shown = refs.filter((r) => r.kind !== 'stash' && r.shortName.toLowerCase().includes(query.toLowerCase()))

  const apply = (): void => {
    const f: HistoryFilter = {
      ...(selected.size ? { refs: [...selected] } : {}),
      ...(author.trim() ? { author: author.trim() } : {}),
      ...(path.trim() ? { path: path.trim().replace(/^\.?\//, '') } : {}),
    }
    onApply(Object.keys(f).length ? f : null)
  }

  return (
    <form
      data-testid="filter-form"
      className="absolute top-6 left-0 z-30 w-80 rounded-md border border-border bg-panel p-3 text-xs shadow-xl shadow-black/40"
      onSubmit={(e) => {
        e.preventDefault()
        apply()
      }}
    >
      <div className="mb-1 font-semibold text-fg">Branches and tags</div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a branch or tag…"
        aria-label="Find a branch or tag"
        className="mb-1 w-full rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent"
      />
      <ul className="mb-3 max-h-40 overflow-y-auto rounded border border-border">
        {shown.length === 0 && <li className="px-2 py-1 text-muted">No matches</li>}
        {shown.map((r) => (
          <li key={r.name}>
            <label className="flex cursor-pointer items-center gap-2 px-2 py-0.5 hover:bg-panel-2">
              <input
                type="checkbox"
                checked={selected.has(r.name)}
                onChange={(e) => {
                  const next = new Set(selected)
                  if (e.target.checked) next.add(r.name)
                  else next.delete(r.name)
                  setSelected(next)
                }}
              />
              <span className="truncate text-fg">{r.shortName}</span>
              <span className="ml-auto text-[10px] text-muted">{r.kind === 'head' ? 'local' : r.kind}</span>
            </label>
          </li>
        ))}
      </ul>
      <label className="mb-1 block font-semibold text-fg" htmlFor="filter-author">
        Author
      </label>
      <input
        id="filter-author"
        value={author}
        onChange={(e) => setAuthor(e.target.value)}
        placeholder="Name or email"
        className="mb-3 w-full rounded border border-border bg-bg px-2 py-1 outline-none focus:border-accent"
      />
      <label className="mb-1 block font-semibold text-fg" htmlFor="filter-path">
        File or folder
      </label>
      <input
        id="filter-path"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="src/components"
        className="mb-3 w-full rounded border border-border bg-bg px-2 py-1 font-mono outline-none focus:border-accent"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => onApply(null)} className="rounded border border-border px-2 py-0.5 text-fg hover:bg-panel-2">
          Show all
        </button>
        <button type="submit" className="rounded bg-accent px-2 py-0.5 font-medium text-on-accent">
          Apply filter
        </button>
      </div>
    </form>
  )
}

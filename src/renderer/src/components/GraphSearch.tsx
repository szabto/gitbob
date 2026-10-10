import { useEffect, useRef, useState } from 'react'
import { useHistorySearch } from '../lib/queries'
import { useAppStore } from '../state/store'

/**
 * Searches the full history through git (message, author, committer, id) and
 * steps through matches. Matches outside the loaded pages are loaded on demand
 * by the graph's reveal logic.
 */
export function GraphSearch({
  repoPath,
  onMatchesChange,
}: {
  repoPath: string
  onMatchesChange: (matches: Set<string> | null) => void
}) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  /** Whether the user has jumped to a match for the current query yet. */
  const [jumped, setJumped] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const reveal = useAppStore((s) => s.reveal)
  const search = useHistorySearch(repoPath, query)
  const shas = query ? (search.data?.shas ?? []) : []

  // Debounce typing.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(input.trim())
      setIndex(0)
      setJumped(false)
    }, 250)
    return () => clearTimeout(t)
  }, [input])

  useEffect(() => {
    onMatchesChange(query && search.data ? new Set(search.data.shas) : null)
  }, [query, search.data, onMatchesChange])

  // Cmd/Ctrl+F focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const go = (delta: number): void => {
    if (shas.length === 0) return
    const next = jumped ? (index + delta + shas.length) % shas.length : delta < 0 ? shas.length - 1 : 0
    setIndex(next)
    setJumped(true)
    reveal(shas[next]!)
  }

  return (
    <div className="ml-auto flex min-w-0 items-center gap-1 pl-2 font-normal" data-testid="graph-search">
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            go(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            setInput('')
            inputRef.current?.blur()
          }
        }}
        placeholder="Search history  ⌘F"
        aria-label="Search history"
        className="h-5 w-52 min-w-16 shrink rounded border border-border bg-bg px-2 text-xs text-fg outline-none placeholder:text-muted focus:border-accent"
      />
      {query && (
        <span className="shrink-0 text-right text-[11px] whitespace-nowrap text-muted" data-testid="search-count">
          {search.isFetching && !search.data
            ? 'Searching…'
            : shas.length === 0
              ? 'No matches'
              : `${Math.min(index + 1, shas.length)} of ${shas.length}${search.data?.truncated ? '+' : ''}`}
        </span>
      )}
      <button
        aria-label="Previous match"
        disabled={shas.length === 0}
        onClick={() => go(-1)}
        className="rounded px-1 text-muted hover:text-fg disabled:opacity-30"
      >
        ↑
      </button>
      <button
        aria-label="Next match"
        disabled={shas.length === 0}
        onClick={() => go(1)}
        className="rounded px-1 text-muted hover:text-fg disabled:opacity-30"
      >
        ↓
      </button>
    </div>
  )
}

import { useAppStore } from '../state/store'

/** One tab per open repository, plus "+" for the start screen. */
export function TabBar() {
  const tabs = useAppStore((s) => s.tabs)
  const repo = useAppStore((s) => s.repo)
  const setRepo = useAppStore((s) => s.setRepo)
  const closeTab = useAppStore((s) => s.closeTab)
  const newTab = useAppStore((s) => s.newTab)
  if (tabs.length === 0) return null

  return (
    <div className="flex h-8 shrink-0 items-end gap-0.5 border-b border-border bg-panel-2 px-2" role="tablist" data-testid="tab-bar">
      {tabs.map((t) => {
        const active = t.root === repo?.root
        return (
          <div
            key={t.root}
            role="tab"
            aria-selected={active}
            data-testid="repo-tab"
            title={t.root}
            onClick={() => setRepo(t)}
            onAuxClick={(e) => e.button === 1 && closeTab(t.root)}
            className={`group flex h-7 max-w-52 cursor-default items-center gap-2 rounded-t border border-b-0 px-3 text-xs ${
              active ? 'border-border bg-panel text-fg' : 'border-transparent text-muted hover:bg-panel/60'
            }`}
          >
            <span className="truncate">{t.name}</span>
            <button
              aria-label={`Close ${t.name}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.root)
              }}
              className={`rounded px-0.5 leading-none hover:bg-fg/10 ${active ? '' : 'invisible group-hover:visible'}`}
            >
              ✕
            </button>
          </div>
        )
      })}
      <button
        aria-label="New tab"
        onClick={newTab}
        className={`mb-0.5 rounded px-2 py-0.5 text-sm text-muted hover:bg-panel hover:text-fg ${repo === null ? 'bg-panel text-fg' : ''}`}
      >
        +
      </button>
    </div>
  )
}

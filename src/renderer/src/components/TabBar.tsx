import { ProfileMenu } from './ProfileMenu'
import { useAppStore } from '../state/store'

/** One tab per open repository, plus "+" for the start screen. */
export function TabBar() {
  const tabs = useAppStore((s) => s.tabs)
  const repo = useAppStore((s) => s.repo)
  const setRepo = useAppStore((s) => s.setRepo)
  const closeTab = useAppStore((s) => s.closeTab)
  const newTab = useAppStore((s) => s.newTab)
  const manage = (): boolean => window.dispatchEvent(new CustomEvent('gitbob:open-settings', { detail: 'profile' }))
  // Without open tabs (welcome screen) only the profile switcher is shown.
  if (tabs.length === 0)
    return (
      <div className="flex shrink-0 justify-end px-2 pt-1">
        <ProfileMenu onManage={manage} />
      </div>
    )

  return (
    <div className="flex h-8 shrink-0 items-end gap-0.5 border-b border-border bg-panel-2 px-2" data-testid="tab-bar">
      <nav aria-label="Open repositories" className="flex min-w-0 items-end gap-0.5">
        {tabs.map((t) => {
          const active = t.root === repo?.root
          return (
            <div
              key={t.root}
              className={`group flex h-7 max-w-52 items-center rounded-t border border-b-0 ${
                active ? 'border-border bg-panel text-fg' : 'border-transparent text-muted hover:bg-panel/60'
              }`}
            >
              <button
                aria-current={active ? 'page' : undefined}
                data-testid="repo-tab"
                title={t.root}
                onClick={() => setRepo(t)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.root)}
                className="min-w-0 truncate py-1 pr-1 pl-3 text-left text-xs"
              >
                {t.name}
              </button>
              <button
                aria-label={`Close ${t.name}`}
                onClick={() => closeTab(t.root)}
                className={`mr-1 rounded px-1 text-xs leading-none hover:bg-fg/10 focus:visible ${active ? '' : 'invisible group-hover:visible'}`}
              >
                ✕
              </button>
            </div>
          )
        })}
      </nav>
      <button
        aria-label="New tab"
        onClick={newTab}
        className={`mb-0.5 rounded px-2 py-0.5 text-sm text-muted hover:bg-panel hover:text-fg ${repo === null ? 'bg-panel text-fg' : ''}`}
      >
        +
      </button>
      <ProfileMenu onManage={manage} />
    </div>
  )
}
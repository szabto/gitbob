import { ChevronDown, ChevronRight, CircleDot } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { ProviderStatus } from '@shared/types'
import { call } from '../lib/api'
import { useSectionOpen } from '../lib/sidebar-sections'

/** Open issues of the connected hosting service; each opens in the browser. */
export function IssuesSection({ repoPath, status }: { repoPath: string; status: ProviderStatus }) {
  const [open, setOpen] = useSectionOpen('issues')
  const issues = useQuery({
    queryKey: ['issues', repoPath],
    queryFn: () => call('provider:issues', { repoPath }),
    enabled: open && status.connected,
    staleTime: 60_000,
  })
  if (!status.connected) return null
  return (
    <section className="mb-1" data-testid="issues" style={{ order: open ? 0 : 2 }}>
      <div className="flex items-center pr-2">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1 px-3 py-1 text-xs font-semibold tracking-wider text-muted uppercase hover:text-fg"
        >
          {open ? <ChevronDown size={12} aria-hidden className="shrink-0" /> : <ChevronRight size={12} aria-hidden className="shrink-0" />}
          <CircleDot size={13} aria-hidden className="shrink-0" />
          Issues
          <span className="ml-auto font-normal">{issues.data ? issues.data.length : ''}</span>
        </button>
      </div>
      {open &&
        (issues.isPending ? (
          <div className="px-7 py-1 text-xs text-muted">Loading…</div>
        ) : issues.isError ? (
          <div className="px-7 py-1 text-xs text-err">{issues.error.message}</div>
        ) : issues.data === null ? (
          <div className="px-7 py-1 text-xs text-muted">This service has no issue tracker for the repository.</div>
        ) : issues.data.length === 0 ? (
          <div className="px-7 py-1 text-xs text-muted">No open issues</div>
        ) : (
          <ul>
            {issues.data.map((i) => (
              <li key={i.number}>
                <button
                  data-testid="issue"
                  title={`${i.title}\n#${i.number} by ${i.author}${i.labels.length ? ` · ${i.labels.join(', ')}` : ''}`}
                  onClick={() => i.url && window.open(i.url, '_blank')}
                  className="flex w-full flex-col py-0.5 pr-3 pl-7 text-left hover:bg-panel-2"
                >
                  <span className="truncate">
                    <span className="text-muted">#{i.number}</span> {i.title}
                  </span>
                  {i.labels.length > 0 && <span className="truncate text-[11px] text-muted">{i.labels.join(' · ')}</span>}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  )
}

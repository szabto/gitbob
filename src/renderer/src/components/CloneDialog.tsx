import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { HostedRepository, ProviderAccount, ProviderKind } from '@shared/types'
import { call } from '../lib/api'
import { useDialog } from '../lib/useDialog'

const LABELS: Record<ProviderKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure: 'Azure DevOps',
}
const MAX_SHOWN = 50

const accountLabel = (a: ProviderAccount, all: ProviderAccount[]): string =>
  all.filter((x) => x.kind === a.kind).length > 1 || !['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com'].includes(a.host)
    ? `${LABELS[a.kind]} (${a.host})`
    : LABELS[a.kind]

/**
 * Clone dialog: a repository URL field that doubles as a searchable dropdown of the
 * repositories of every connected hosting account.
 */
export function CloneDialog({ onClose }: { onClose: (url: string | null) => void }) {
  const [url, setUrl] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [useSsh, setUseSsh] = useState(false)
  const dialogRef = useDialog<HTMLFormElement>(() => onClose(null))

  const accounts = useQuery({ queryKey: ['provider-accounts'], queryFn: () => call('provider:accounts', {}), staleTime: 0 })
  const list = accounts.data ?? []
  const repos = useQueries({
    queries: list.map((a) => ({
      queryKey: ['hosted-repos', a.kind, a.host],
      queryFn: () => call('provider:hosted-repos', { kind: a.kind, host: a.host }),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  })

  const loading = repos.some((r) => r.isLoading)
  const errors = repos.flatMap((r, i) => (r.error ? [`${accountLabel(list[i]!, list)}: ${(r.error as Error).message}`] : []))
  const all = useMemo(() => repos.flatMap((r) => r.data ?? []), [repos])
  const term = url.trim().toLowerCase()
  // While the field holds a picked URL, show everything again instead of filtering it away.
  const picked = all.some((r) => r.cloneUrl === url || r.sshUrl === url)
  const matches = useMemo(
    () => (picked || !term ? all : all.filter((r) => r.fullName.toLowerCase().includes(term) || (r.description ?? '').toLowerCase().includes(term))),
    [all, term, picked],
  )
  const shown = matches.slice(0, MAX_SHOWN)
  const showList = open && list.length > 0

  const choose = (r: HostedRepository): void => {
    setUrl(useSsh && r.sshUrl ? r.sshUrl : r.cloneUrl)
    setOpen(false)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={() => onClose(null)}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Clone a repository"
        data-testid="clone-dialog"
        className="w-[560px] max-w-[calc(100vw-32px)] rounded-lg border border-border bg-panel p-4 shadow-2xl"
        onMouseDown={(e) => {
          e.stopPropagation()
          if (!(e.target as HTMLElement).closest('[data-clone-combo]')) setOpen(false)
        }}
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim()) onClose(url.trim())
        }}
      >
        <h2 className="mb-3 font-semibold">Clone a repository</h2>
        <label className="mb-1 block text-xs text-muted" htmlFor="clone-url">
          Repository URL
        </label>
        <div className="relative" data-clone-combo>
          <input
            id="clone-url"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            role={list.length ? 'combobox' : undefined}
            aria-expanded={list.length ? showList : undefined}
            aria-controls={showList ? 'clone-repo-list' : undefined}
            aria-activedescendant={showList && shown[active] ? `clone-repo-${active}` : undefined}
            value={url}
            placeholder={list.length ? 'Search your repositories or paste a URL' : 'https://github.com/owner/repo.git'}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => {
              setUrl(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (!showList || shown.length === 0) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, shown.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter' && !picked && term && !/^(https?:|ssh:|git@|\/|[a-z]:\\)/i.test(term)) {
                // Enter on a search term picks the highlighted repository; on a URL it submits.
                e.preventDefault()
                choose(shown[active]!)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
              }
            }}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
          />
          {showList && (
            <ul
              id="clone-repo-list"
              role="listbox"
              aria-label="Your repositories"
              data-testid="clone-repo-list"
              className="absolute top-full right-0 left-0 z-10 mt-1 max-h-72 overflow-y-auto rounded border border-border bg-panel py-1 text-sm shadow-xl"
            >
              {shown.map((r, i) => (
                <li
                  key={`${r.kind}:${r.host}:${r.fullName}`}
                  id={`clone-repo-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-testid="clone-repo"
                  data-name={r.fullName}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r)}
                  className={`cursor-pointer px-3 py-1.5 ${i === active ? 'bg-accent/15' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{r.fullName}</span>
                    {r.private && <span className="rounded border border-border px-1 text-[10px] text-muted">Private</span>}
                    {list.length > 1 && (
                      <span className="ml-auto shrink-0 text-xs text-muted">
                        {accountLabel({ kind: r.kind, host: r.host }, list)}
                      </span>
                    )}
                  </div>
                  {r.description && <div className="truncate text-xs text-muted">{r.description}</div>}
                </li>
              ))}
              {loading && <li className="px-3 py-1.5 text-xs text-muted">Loading your repositories…</li>}
              {!loading && shown.length === 0 && (
                <li className="px-3 py-1.5 text-xs text-muted">{term && !picked ? 'No matching repositories. Press Enter to use it as a URL.' : 'No repositories found.'}</li>
              )}
              {matches.length > MAX_SHOWN && (
                <li className="px-3 py-1.5 text-xs text-muted">{matches.length - MAX_SHOWN} more: type to narrow down.</li>
              )}
              {errors.map((m) => (
                <li key={m} role="alert" className="px-3 py-1.5 text-xs text-err">
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted">
          {list.length > 0 ? (
            <>
              <span>From {list.map((a) => accountLabel(a, list)).join(', ')}</span>
              <label className="ml-auto flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={useSsh}
                  onChange={(e) => {
                    setUseSsh(e.target.checked)
                    const r = all.find((x) => x.cloneUrl === url || x.sshUrl === url)
                    if (r) setUrl(e.target.checked && r.sshUrl ? r.sshUrl : r.cloneUrl)
                  }}
                />
                Use SSH
              </label>
            </>
          ) : (
            <span>Connect GitHub, GitLab, Bitbucket or Azure DevOps in a repository’s sidebar to pick from your repositories here.</span>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onClose(null)} className="rounded border border-border px-3 py-1 hover:bg-panel-2">
            Cancel
          </button>
          <button type="submit" disabled={!url.trim()} className="rounded bg-accent px-3 py-1 font-medium text-on-accent disabled:opacity-40">
            Choose folder…
          </button>
        </div>
      </form>
    </div>
  )
}

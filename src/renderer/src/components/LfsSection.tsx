import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useUiStore } from '../state/ui'

/** Git LFS status and actions; hidden for repositories that don't use LFS (and can't). */
export function LfsSection({ repoPath }: { repoPath: string }) {
  const [open, setOpen] = useState(true)
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['lfs', repoPath], queryFn: () => call('lfs:status', { repoPath }), staleTime: 60_000 })
  const { ask, showError, showNotice, setBusy, openMenu } = useUiStore.getState()
  const s = status.data
  if (!s) return null
  const usesLfs = s.trackedPatterns.length > 0 || s.files.length > 0 || s.enabledInRepo
  if (!usesLfs && !s.installed) return null

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['lfs', repoPath] })
    void qc.invalidateQueries({ queryKey: ['status', repoPath] })
  }
  const run = async (label: string | null, fn: () => Promise<unknown>, done?: string): Promise<void> => {
    if (label) setBusy(label)
    try {
      await fn()
      if (done) showNotice(done)
    } catch (e) {
      showError(e)
    } finally {
      if (label) setBusy(null)
      refresh()
    }
  }
  const missing = s.files.filter((f) => !f.downloaded).length

  return (
    <section className="mb-1" data-testid="lfs">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-3 py-1 text-xs font-semibold tracking-wider text-muted uppercase hover:text-fg"
      >
        <span className="inline-block w-3">{open ? '▾' : '▸'}</span>
        Git LFS
        <span className="ml-auto font-normal">{s.files.length}</span>
      </button>
      {open && (
        <div className="space-y-1 px-7 pb-1 text-xs">
          {!s.installed ? (
            <p className="text-warn" data-testid="lfs-missing">
              This repository uses Git LFS, but git-lfs isn’t installed.{' '}
              <a href="https://git-lfs.com/" target="_blank" rel="noreferrer" className="underline">
                Install Git LFS
              </a>
            </p>
          ) : (
            <>
              <p className="text-muted">
                {s.files.length} file{s.files.length === 1 ? '' : 's'}
                {s.filesTruncated ? '+' : ''}
                {missing > 0 ? ` · ${missing} not downloaded` : ''}
              </p>
              {!s.enabledInRepo && (
                <button className="rounded border border-border px-2 py-0.5 hover:bg-panel-2" onClick={() => void run(null, () => call('lfs:install', { repoPath }), 'Git LFS is set up for this repository.')}>
                  Set up LFS here
                </button>
              )}
              {missing > 0 && (
                <button className="ml-1 rounded border border-border px-2 py-0.5 hover:bg-panel-2" onClick={() => void run('Downloading LFS files…', () => call('lfs:pull', { repoPath }), 'LFS files downloaded.')}>
                  Download files
                </button>
              )}
              <ul data-testid="lfs-patterns">
                {s.trackedPatterns.map((p) => (
                  <li
                    key={`${p.source}:${p.pattern}`}
                    title={`Tracked in ${p.source}`}
                    className="truncate font-mono"
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openMenu(e.clientX, e.clientY, [
                        { label: `Stop tracking ${p.pattern}`, onSelect: () => void run(null, () => call('lfs:untrack', { repoPath, pattern: p.pattern }), `Stopped tracking ${p.pattern}. Commit .gitattributes to share this.`) },
                      ])
                    }}
                  >
                    {p.pattern}
                  </li>
                ))}
              </ul>
              <button
                className="text-accent hover:underline"
                onClick={async () => {
                  const pattern = await ask({
                    title: 'Track files with Git LFS',
                    label: 'File pattern',
                    placeholder: '*.psd',
                    confirmLabel: 'Track',
                    help: 'Matching files are stored in LFS from now on. GitBob updates .gitattributes; commit it to share the setting.',
                  })
                  if (pattern) await run(null, () => call('lfs:track', { repoPath, pattern }), `Now tracking ${pattern} with LFS. Commit .gitattributes to share this.`)
                }}
              >
                + Track a file pattern…
              </button>
            </>
          )}
        </div>
      )}
    </section>
  )
}

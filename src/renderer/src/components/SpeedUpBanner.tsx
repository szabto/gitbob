import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useUiStore } from '../state/ui'

const DISMISSED_KEY = 'gitbob.commitGraphDismissed'

function dismissedRepos(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Offers to write Git's commit-graph when the first history page was slow and the repository has
 * none (typical for fresh clones of large projects). Writing it changes only Git's own cache files.
 */
export function SpeedUpBanner({ repoPath, historyLoaded }: { repoPath: string; historyLoaded: boolean }) {
  const [dismissed, setDismissed] = useState(() => dismissedRepos().includes(repoPath))
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const { showError, showNotice } = useUiStore.getState()
  const health = useQuery({
    queryKey: ['repo-health', repoPath],
    queryFn: () => call('repo:health', { repoPath }),
    enabled: historyLoaded && !dismissed,
    staleTime: Infinity,
  })
  if (dismissed || !health.data?.suggestCommitGraph) return null

  const dismiss = (): void => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedRepos(), repoPath].slice(-200)))
    } catch {
      /* per-viewer convenience */
    }
  }
  const build = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('repo:write-commit-graph', { repoPath })
      showNotice('History index built. Loading history is faster now.')
      qc.setQueryData(['repo-health', repoPath], { suggestCommitGraph: false })
      void qc.invalidateQueries({ queryKey: ['log', repoPath] })
    } catch (e) {
      showError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="status" data-testid="speed-up-banner" className="flex items-center gap-3 border-b border-info/40 bg-info/10 px-4 py-1.5 text-sm">
      <span className="text-muted">
        <strong className="text-fg">This history loads slowly.</strong> Git can build an index of it (the commit-graph, as{' '}
        <code>git gc</code> does) to make it load several times faster.
      </span>
      <div className="ml-auto flex shrink-0 gap-2">
        <button disabled={busy} onClick={() => void build()} className="rounded bg-accent px-2.5 py-0.5 font-medium text-on-accent disabled:opacity-40">
          {busy ? 'Building…' : 'Speed up history'}
        </button>
        <button disabled={busy} onClick={dismiss} className="rounded border border-border px-2.5 py-0.5 hover:bg-panel-2">
          Not now
        </button>
      </div>
    </div>
  )
}

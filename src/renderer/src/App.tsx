import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RepositoryInfo } from '@shared/types'
import { useQueryClient } from '@tanstack/react-query'
import { call, subscribe } from './lib/api'
import { useAppStore } from './state/store'
import { Welcome } from './components/Welcome'
import { RepositoryView } from './components/RepositoryView'
import { ErrorBanner } from './components/ErrorBanner'
import { ContextMenu, PromptDialog } from './components/Overlays'
import { CloneDialog } from './components/CloneDialog'
import { CredentialDialog } from './components/CredentialDialog'
import { TabBar } from './components/TabBar'
import { CommandHost } from './components/CommandHost'
import { useUiStore } from './state/ui'

export function App() {
  const repo = useAppStore((s) => s.repo)
  const setRepo = useAppStore((s) => s.setRepo)
  const queryClient = useQueryClient()
  const error = useUiStore((s) => s.error)
  const showError = useUiStore((s) => s.showError)
  const clearError = useUiStore((s) => s.clearError)
  const notice = useUiStore((s) => s.notice)
  const showNotice = useUiStore((s) => s.showNotice)

  const handleOpened = useCallback(
    (info: Parameters<typeof setRepo>[0]) => {
      clearError()
      setRepo(info)
      void queryClient.invalidateQueries({ queryKey: ['recent'] })
    },
    [setRepo, queryClient, clearError],
  )

  const setBusy = useUiStore((s) => s.setBusy)
  const setProgress = useUiStore((s) => s.setProgress)
  useEffect(() => subscribe('op:progress', (p) => setProgress(p)), [setProgress])

  const [cloneOpen, setCloneOpen] = useState(false)
  const cloneRepository = useCallback(() => setCloneOpen(true), [])
  const finishClone = useCallback(async (url: string | null) => {
    setCloneOpen(false)
    if (!url) return
    setBusy('Cloning…')
    try {
      const info = await call('repo:clone', { url })
      if (info) handleOpened(info)
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && (e as { code: string }).code === 'CANCELLED')) showError(e)
    } finally {
      setBusy(null)
    }
  }, [setBusy, handleOpened, showError])

  const initRepository = useCallback(async () => {
    try {
      const info = await call('repo:init', {})
      if (info) handleOpened(info)
    } catch (e) {
      showError(e)
    }
  }, [handleOpened, showError])

  const pickRepository = useCallback(async () => {
    try {
      const info = await call('repo:pick', {})
      if (info) handleOpened(info)
    } catch (e) {
      showError(e)
    }
  }, [handleOpened, showError])

  const openPath = useCallback(
    async (path: string) => {
      try {
        handleOpened(await call('repo:open', { path }))
      } catch (e) {
        showError(e)
      }
    },
    [handleOpened, showError],
  )

  // Theme: "system" follows prefers-color-scheme in CSS; light/dark are forced via data-theme.
  useEffect(() => {
    const apply = (theme: string): void => {
      document.documentElement.dataset.theme = theme
    }
    void call('settings:get', {}).then((s) => apply(s.theme))
    return subscribe('theme:changed', ({ theme }) => apply(theme))
  }, [])

  const commandApp = useMemo(
    () => ({ openRepository: () => void pickRepository(), cloneRepository: () => void cloneRepository(), initRepository: () => void initRepository() }),
    [pickRepository, cloneRepository, initRepository],
  )

  // Restore the previous session's tabs once, then remember them as they change.
  const tabs = useAppStore((s) => s.tabs)
  const [restored, setRestored] = useState(false)
  useEffect(() => {
    let saved: { paths: string[]; active: string | null } = { paths: [], active: null }
    try {
      saved = JSON.parse(localStorage.getItem('gitbob.tabs') ?? 'null') ?? saved
    } catch {
      /* storage unavailable or corrupt: start empty */
    }
    void (async () => {
      const store = useAppStore.getState()
      const already = new Set(store.tabs.map((t) => t.root))
      const opened: RepositoryInfo[] = []
      for (const path of Array.isArray(saved.paths) ? saved.paths.slice(0, 20) : []) {
        if (typeof path !== 'string' || already.has(path)) continue
        try {
          opened.push(await call('repo:open', { path }))
        } catch {
          /* folder moved or deleted: skip */
        }
      }
      // A repository passed on the command line may already be open; keep it active.
      const current = useAppStore.getState().repo
      for (const info of opened) useAppStore.getState().setRepo(info)
      const active = current ?? opened.find((o) => o.root === saved.active) ?? opened.at(-1) ?? null
      if (active) useAppStore.getState().setRepo(active)
      setRestored(true)
    })()
  }, [])
  useEffect(() => {
    if (!restored) return
    try {
      localStorage.setItem('gitbob.tabs', JSON.stringify({ paths: tabs.map((t) => t.root), active: repo?.root ?? null }))
    } catch {
      /* storage unavailable: tabs simply won't be restored */
    }
  }, [tabs, repo, restored])

  // Keep the main process's filesystem watcher on the visible tab.
  const activeRoot = repo?.root
  useEffect(() => {
    if (activeRoot) void call('repo:activate', { repoPath: activeRoot }).catch(() => {})
  }, [activeRoot])

  useEffect(() => subscribe('repo:opened', handleOpened), [handleOpened])
  useEffect(() => subscribe('menu:open-repository', () => void pickRepository()), [pickRepository])
  useEffect(() => subscribe('menu:clone-repository', () => void cloneRepository()), [cloneRepository])
  useEffect(() => subscribe('menu:init-repository', () => void initRepository()), [initRepository])

  return (
    <div className="flex h-full flex-col">
      {error && <ErrorBanner error={error} onDismiss={clearError} />}
      {notice && (
        <div role="status" data-testid="notice" className="flex items-start gap-3 border-b border-info/40 bg-info/10 px-4 py-2 text-sm">
          <span className="flex-1 text-fg">{notice}</span>
          <button onClick={() => showNotice(null)} aria-label="Dismiss notice" className="text-muted hover:text-fg">
            ✕
          </button>
        </div>
      )}
      <TabBar />
      {!repo && <GlobalBusy />}
      {repo ? (
        <RepositoryView key={repo.root} repo={repo} onOpen={pickRepository} onClose={() => setRepo(null)} />
      ) : (
        <Welcome onPick={pickRepository} onOpenPath={openPath} onClone={cloneRepository} onInit={initRepository} />
      )}
      <CommandHost repo={repo} app={commandApp} />
      <ContextMenu />
      <PromptDialog />
      {cloneOpen && <CloneDialog onClose={(url) => void finishClone(url)} />}
      <CredentialDialog />
    </div>
  )
}

/** Progress for operations started without an open repository (e.g. clone). */
function GlobalBusy() {
  const busy = useUiStore((s) => s.busy)
  const progress = useUiStore((s) => s.progress)
  if (!busy) return null
  return (
    <div role="status" data-testid="global-busy" className="flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-sm">
      <span className="animate-pulse text-accent">
        {busy}
        {progress ? ` ${progress.phase} ${progress.percent}%` : ''}
      </span>
      {progress && (
        <span className="h-1 w-40 overflow-hidden rounded bg-panel-2">
          <span className="block h-full bg-gradient-to-r from-accent to-accent-2" style={{ width: `${progress.percent}%` }} />
        </span>
      )}
      <button className="ml-auto rounded border border-border px-2 text-xs text-muted hover:text-fg" onClick={() => void call('op:cancel', {})}>
        Cancel
      </button>
    </div>
  )
}

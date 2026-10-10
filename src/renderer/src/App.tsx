import { useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { call, subscribe } from './lib/api'
import { useAppStore } from './state/store'
import { Welcome } from './components/Welcome'
import { RepositoryView } from './components/RepositoryView'
import { ErrorBanner } from './components/ErrorBanner'
import { ContextMenu, PromptDialog } from './components/Overlays'
import { CredentialDialog } from './components/CredentialDialog'
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

  useEffect(() => subscribe('repo:opened', handleOpened), [handleOpened])
  useEffect(() => subscribe('menu:open-repository', () => void pickRepository()), [pickRepository])

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
      {repo ? (
        <RepositoryView key={repo.root} repo={repo} onOpen={pickRepository} onClose={() => setRepo(null)} />
      ) : (
        <Welcome onPick={pickRepository} onOpenPath={openPath} />
      )}
      <ContextMenu />
      <PromptDialog />
      <CredentialDialog />
    </div>
  )
}

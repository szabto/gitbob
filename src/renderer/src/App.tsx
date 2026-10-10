import { useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { call, subscribe } from './lib/api'
import { useAppStore } from './state/store'
import { Welcome } from './components/Welcome'
import { RepositoryView } from './components/RepositoryView'
import { ErrorBanner } from './components/ErrorBanner'
import { ContextMenu, PromptDialog } from './components/Overlays'
import { useUiStore } from './state/ui'

export function App() {
  const repo = useAppStore((s) => s.repo)
  const setRepo = useAppStore((s) => s.setRepo)
  const queryClient = useQueryClient()
  const error = useUiStore((s) => s.error)
  const showError = useUiStore((s) => s.showError)
  const clearError = useUiStore((s) => s.clearError)

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

  useEffect(() => subscribe('repo:opened', handleOpened), [handleOpened])
  useEffect(() => subscribe('menu:open-repository', () => void pickRepository()), [pickRepository])

  return (
    <div className="flex h-full flex-col">
      {error && <ErrorBanner error={error} onDismiss={clearError} />}
      {repo ? (
        <RepositoryView key={repo.root} repo={repo} onOpen={pickRepository} onClose={() => setRepo(null)} />
      ) : (
        <Welcome onPick={pickRepository} onOpenPath={openPath} />
      )}
      <ContextMenu />
      <PromptDialog />
    </div>
  )
}

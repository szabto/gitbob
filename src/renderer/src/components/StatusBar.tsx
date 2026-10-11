import { useQuery } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useAppInfo } from '../lib/queries'
import { useUiStore } from '../state/ui'

const STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

/** Bottom bar: what happened last (or what's running), zoom, and the app version. */
export function StatusBar() {
  const busy = useUiStore((s) => s.busy)
  const last = useUiStore((s) => s.lastMessage)
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => call('settings:get', {}) })
  const info = useAppInfo()
  const zoom = settings.data?.zoom ?? 1
  const setZoom = (z: number): void => void call('settings:update', { patch: { zoom: z } })
  const step = (dir: 1 | -1): void => {
    const next = dir > 0 ? STEPS.find((s) => s > zoom + 0.001) : [...STEPS].reverse().find((s) => s < zoom - 0.001)
    if (next) setZoom(next)
  }
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-xs text-muted" data-testid="status-bar">
      <span className="min-w-0 flex-1 truncate" data-testid="status-message" title={last?.text}>
        {busy ?? last?.text ?? 'Ready'}
      </span>
      <div className="flex items-center" role="group" aria-label="Zoom">
        <button className="px-1.5 hover:text-fg" aria-label="Zoom out" onClick={() => step(-1)}>
          −
        </button>
        <button className="w-11 text-center tabular-nums hover:text-fg" title="Reset zoom" aria-label={`Zoom ${Math.round(zoom * 100)}%, reset`} data-testid="zoom-level" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="px-1.5 hover:text-fg" aria-label="Zoom in" onClick={() => step(1)}>
          +
        </button>
      </div>
      {info.data && <span data-testid="app-version">GitBob {info.data.version}</span>}
    </footer>
  )
}

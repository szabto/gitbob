import { useAppInfo, useRecent } from '../lib/queries'
import { displayPath } from '../lib/format'
import { Onboarding } from './Onboarding'
import logoUrl from '../assets/logo.png'

export function Welcome({
  onPick,
  onOpenPath,
  onClone,
  onInit,
}: {
  onPick: () => void
  onOpenPath: (path: string) => void
  onClone: () => void
  onInit: () => void
}) {
  const recent = useRecent()
  const info = useAppInfo()

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto py-[8vh]">
      <div className="w-[520px] max-w-[90vw]">
        <div className="mb-8 flex items-center gap-3">
          <Logo size={72} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">GitBob</h1>
            <p className="text-muted">A desktop Git client</p>
          </div>
        </div>

        <button
          onClick={onPick}
          className="w-full rounded-md bg-gradient-to-r from-accent to-accent-2 px-4 py-2.5 font-medium text-on-accent hover:brightness-110"
        >
          Open Repository…
        </button>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button onClick={onClone} className="rounded-md border border-border px-4 py-2 hover:bg-panel-2">
            Clone…
          </button>
          <button onClick={onInit} className="rounded-md border border-border px-4 py-2 hover:bg-panel-2">
            New repository…
          </button>
        </div>

        <h2 className="mt-8 mb-2 text-xs font-semibold tracking-wider text-muted uppercase">Recent repositories</h2>
        <div className="rounded-md border border-border bg-panel">
          {recent.data && recent.data.length > 0 ? (
            <ul>
              {recent.data.map((r) => (
                <li key={r.path}>
                  <button
                    data-testid="recent-repo"
                    onClick={() => onOpenPath(r.path)}
                    className="flex w-full flex-col items-start border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-panel-2"
                  >
                    <span className="font-medium">{r.name}</span>
                    <span className="w-full truncate text-xs text-muted" title={r.path}>
                      {displayPath(r.path, info.data?.home)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-muted">No recent repositories.</p>
          )}
        </div>
        <Onboarding />
      </div>
    </div>
  )
}

export function Logo({ size = 40 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" draggable={false} className="shrink-0" />
}

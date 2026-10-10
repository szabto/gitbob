import type { ApiError } from '../lib/api'

export function ErrorBanner({ error, onDismiss }: { error: ApiError; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 border-b border-err/40 bg-err/10 px-4 py-2 text-sm">
      <div className="flex-1">
        <div className="font-medium text-err" data-testid="error-message">
          {error.message}
        </div>
        {error.detail && error.detail !== error.message && (
          <pre className="selectable mt-1 max-h-24 overflow-auto font-mono text-xs whitespace-pre-wrap text-err">
            {error.detail}
          </pre>
        )}
      </div>
      <button className="text-err hover:text-fg" onClick={onDismiss} aria-label="Dismiss error">
        ✕
      </button>
    </div>
  )
}

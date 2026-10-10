import type { ApiError } from '../lib/api'

export function ErrorBanner({ error, onDismiss }: { error: ApiError; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 border-b border-red-900/60 bg-red-950/60 px-4 py-2 text-sm">
      <div className="flex-1">
        <div className="font-medium text-red-200" data-testid="error-message">
          {error.message}
        </div>
        {error.detail && error.detail !== error.message && (
          <pre className="selectable mt-1 max-h-24 overflow-auto font-mono text-xs whitespace-pre-wrap text-red-300/80">
            {error.detail}
          </pre>
        )}
      </div>
      <button className="text-red-200 hover:text-white" onClick={onDismiss} aria-label="Dismiss error">
        ✕
      </button>
    </div>
  )
}

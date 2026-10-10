import { useEffect, useState } from 'react'
import type { IpcEvents } from '@shared/ipc-types'
import { call, subscribe } from '../lib/api'
import { useUiStore } from '../state/ui'

type Request = IpcEvents['credentials:request']

/** Answers git's credential prompts (relayed by the main process via GIT_ASKPASS). */
export function CredentialDialog() {
  const [queue, setQueue] = useState<Request[]>([])
  const showNotice = useUiStore((s) => s.showNotice)

  useEffect(() => {
    const offReq = subscribe('credentials:request', (r) => setQueue((q) => [...q, r]))
    const offCancel = subscribe('credentials:cancel', ({ id }) => setQueue((q) => q.filter((r) => r.id !== id)))
    const offSaved = subscribe('credentials:saved', ({ host, saved }) =>
      showNotice(
        saved
          ? `Your credentials for ${host} were saved by your system's secure credential store.`
          : `Could not save credentials for ${host}: no secure credential helper is available for Git on this system.`,
      ),
    )
    return () => {
      offReq()
      offCancel()
      offSaved()
    }
  }, [showNotice])

  const current = queue[0]
  if (!current) return null

  const answer = (value: string | null, remember = false): void => {
    setQueue((q) => q.slice(1))
    void call('credentials:respond', { id: current.id, answer: value, remember })
  }

  return <CredentialForm key={current.id} request={current} onAnswer={answer} />
}

function CredentialForm({
  request,
  onAnswer,
}: {
  request: Request
  onAnswer: (v: string | null, remember?: boolean) => void
}) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  const label = request.prompt.replace(/:\s*$/, '')

  if (request.confirm) {
    // ssh host-key question; the prompt contains the host and its key fingerprint.
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]">
        <div
          role="dialog"
          aria-label="Unknown SSH host"
          data-testid="host-key-dialog"
          className="w-[520px] rounded-lg border border-border bg-panel p-4 shadow-2xl"
          onKeyDown={(e) => e.key === 'Escape' && onAnswer(null)}
        >
          <h2 className="mb-2 font-semibold">Trust this server?</h2>
          <p className="mb-2 text-xs text-muted">
            This is the first connection to this server. Compare the fingerprint below with the one your Git host
            publishes before trusting it.
          </p>
          <pre className="selectable mb-3 max-h-48 overflow-auto rounded border border-border bg-bg p-2 font-mono text-xs whitespace-pre-wrap">
            {request.prompt.trim()}
          </pre>
          <div className="flex justify-end gap-2">
            <button autoFocus className="rounded border border-border px-3 py-1 hover:bg-panel-2" onClick={() => onAnswer(null)}>
              Cancel
            </button>
            <button className="rounded bg-accent px-3 py-1 font-medium text-[#0b1220]" onClick={() => onAnswer('yes')}>
              Trust and connect
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]">
      <form
        role="dialog"
        aria-label="Git credentials"
        data-testid="credential-dialog"
        className="w-[440px] rounded-lg border border-border bg-panel p-4 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          onAnswer(value, remember)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onAnswer(null)
        }}
      >
        <h2 className="mb-1 font-semibold">Authentication required</h2>
        <p className="mb-3 text-xs text-muted">
          Git is asking for credentials. GitBob passes them to Git and never writes them to disk itself.
        </p>
        <label className="mb-1 block text-xs text-muted" htmlFor="credential-input">
          {label}
        </label>
        <input
          id="credential-input"
          autoFocus
          type={request.secret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono outline-none focus:border-accent"
        />
        {request.rememberable && (
          <label className="mt-3 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-testid="remember-credentials" />
            Remember in my system keychain (saved only if the sign-in works)
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded border border-border px-3 py-1 hover:bg-panel-2" onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button type="submit" className="rounded bg-accent px-3 py-1 font-medium text-[#0b1220]">
            Continue
          </button>
        </div>
      </form>
    </div>
  )
}

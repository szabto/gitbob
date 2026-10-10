import { useEffect, useState } from 'react'
import type { IpcEvents } from '@shared/ipc-types'
import { call, subscribe } from '../lib/api'

type Request = IpcEvents['credentials:request']

/** Answers git's credential prompts (relayed by the main process via GIT_ASKPASS). */
export function CredentialDialog() {
  const [queue, setQueue] = useState<Request[]>([])

  useEffect(() => {
    const offReq = subscribe('credentials:request', (r) => setQueue((q) => [...q, r]))
    const offCancel = subscribe('credentials:cancel', ({ id }) => setQueue((q) => q.filter((r) => r.id !== id)))
    return () => {
      offReq()
      offCancel()
    }
  }, [])

  const current = queue[0]
  if (!current) return null

  const answer = (value: string | null): void => {
    setQueue((q) => q.slice(1))
    void call('credentials:respond', { id: current.id, answer: value })
  }

  return <CredentialForm key={current.id} request={current} onAnswer={answer} />
}

function CredentialForm({ request, onAnswer }: { request: Request; onAnswer: (v: string | null) => void }) {
  const [value, setValue] = useState('')
  const label = request.prompt.replace(/:\s*$/, '')
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]">
      <form
        role="dialog"
        aria-label="Git credentials"
        data-testid="credential-dialog"
        className="w-[440px] rounded-lg border border-border bg-panel p-4 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          onAnswer(value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onAnswer(null)
        }}
      >
        <h2 className="mb-1 font-semibold">Authentication required</h2>
        <p className="mb-3 text-xs text-muted">
          Git is asking for credentials. They are passed to Git for this operation only and are not stored by GitBob;
          your Git credential helper may remember them.
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

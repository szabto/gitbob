import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useAppInfo } from '../lib/queries'
import { formatAccelerator } from '../lib/shortcuts'
import { useUiStore } from '../state/ui'

const TIPS_KEY = 'gitbob.tipsDismissed'

function tipsDismissed(): boolean {
  try {
    return localStorage.getItem(TIPS_KEY) === '1'
  } catch {
    return false
  }
}

/** Start-screen checklist: Git installed, identity set, plus a few first-run tips. */
export function Onboarding() {
  const info = useAppInfo()
  const identity = useQuery({ queryKey: ['git-identity'], queryFn: () => call('app:git-identity', {}) })
  const [hideTips, setHideTips] = useState(tipsDismissed)
  const needsIdentity = identity.data && (!identity.data.name || !identity.data.email)
  const gitMissing = info.data && !info.data.gitVersion

  return (
    <div className="mt-8 space-y-3" data-testid="onboarding">
      {gitMissing && (
        <div role="alert" className="rounded-md border border-err/40 bg-err/10 p-3 text-sm" data-testid="git-missing">
          <strong>Git is not installed</strong> (or not found). GitBob uses the Git on your computer for everything.{' '}
          <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer" className="text-accent underline">
            Download Git
          </a>
          , then restart GitBob, or choose a Git program in Settings.
        </div>
      )}
      {info.data?.gitVersion && (
        <p className="text-xs text-muted" data-testid="git-ok">
          ✓ Using Git {info.data.gitVersion}
          {identity.data?.name && identity.data.email ? ` as ${identity.data.name} <${identity.data.email}>` : ''}
        </p>
      )}
      {needsIdentity && <IdentityForm initial={identity.data!} />}
      {!hideTips && (
        <div className="rounded-md border border-border bg-panel p-3 text-sm" data-testid="tips">
          <div className="mb-1 flex items-center">
            <strong>Tips</strong>
            <button
              className="ml-auto text-xs text-muted hover:text-fg"
              onClick={() => {
                setHideTips(true)
                try {
                  localStorage.setItem(TIPS_KEY, '1')
                } catch {
                  /* per-viewer convenience */
                }
              }}
            >
              Hide tips
            </button>
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-muted">
            <li>
              Press <kbd className="text-fg">{formatAccelerator('Mod+K')}</kbd> to run any command or switch branches by typing.
            </li>
            <li>Open several repositories at once: each one gets its own tab.</li>
            <li>Right-click commits and branches for everything else: cherry-pick, revert, rebase, tags…</li>
            <li>Risky actions always ask first, and GitBob keeps backups (Trash, backup stashes) where it can.</li>
          </ul>
        </div>
      )}
    </div>
  )
}

function IdentityForm({ initial }: { initial: { name: string; email: string } }) {
  const [name, setName] = useState(initial.name)
  const [email, setEmail] = useState(initial.email)
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const { showError, showNotice } = useUiStore.getState()
  return (
    <form
      className="rounded-md border border-warn/40 bg-warn/10 p-3 text-sm"
      data-testid="identity-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await call('app:set-git-identity', { name, email })
          void qc.invalidateQueries({ queryKey: ['git-identity'] })
          showNotice('Your name and email are set for new commits.')
        } catch (err) {
          showError(err)
        } finally {
          setBusy(false)
        }
      }}
    >
      <p className="mb-2">
        <strong>Tell Git who you are.</strong> Every commit records a name and email. This sets them for all your
        repositories (same as <code>git config --global</code>).
      </p>
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="identity-name">
          Name
        </label>
        <input
          id="identity-name"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-40 flex-1 rounded border border-border bg-bg px-2 py-1"
        />
        <label className="sr-only" htmlFor="identity-email">
          Email
        </label>
        <input
          id="identity-email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-48 flex-1 rounded border border-border bg-bg px-2 py-1"
        />
        <button type="submit" disabled={busy || !name.trim() || !email.trim()} className="rounded bg-accent px-3 py-1 font-medium text-on-accent disabled:opacity-40">
          Save
        </button>
      </div>
    </form>
  )
}

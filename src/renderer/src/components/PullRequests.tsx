import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { GitRef, ProviderKind, ProviderStatus, RepoRef } from '@shared/types'
import { call } from '../lib/api'
import { useDialog } from '../lib/useDialog'
import { usePullRequests } from '../lib/queries'
import { useUiStore } from '../state/ui'
import { useAppStore } from '../state/store'
import type { useRepoActions } from '../lib/actions'

export const PROVIDER_NAMES: Record<ProviderKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure: 'Azure DevOps',
}

/** Where users create a personal access token, and what it needs. */
function tokenHelp(ref: RepoRef): { url: string; text: string } {
  switch (ref.kind) {
    case 'github':
      return {
        url: `https://${ref.host === 'github.com' ? 'github.com' : ref.host}/settings/personal-access-tokens/new`,
        text: 'Create a fine-grained token with read access to Pull requests, Checks and Commit statuses (write access to Pull requests to create them).',
      }
    case 'gitlab':
      return { url: `https://${ref.host}/-/user_settings/personal_access_tokens`, text: 'Create a token with the "api" scope.' }
    case 'bitbucket':
      return {
        url: 'https://bitbucket.org/account/settings/app-passwords/',
        text: 'Enter it as username:app-password (Pull requests read/write, Repositories read).',
      }
    case 'azure':
      return {
        url: `https://dev.azure.com/${ref.owner}/_usersSettings/tokens`,
        text: 'Create a token with Code (Read & write) and, for your name, User Profile (Read) for all accessible organizations.',
      }
  }
}

export function PullRequestsSection({
  repoPath,
  status,
  remoteRefs,
  actions,
}: {
  repoPath: string
  status: ProviderStatus
  remoteRefs: GitRef[]
  actions: ReturnType<typeof useRepoActions>
}) {
  const [open, setOpen] = useState(true)
  const qc = useQueryClient()
  const { ask, showError, showNotice, openMenu } = useUiStore.getState()
  const pulls = usePullRequests(repoPath, status.connected && open)
  const ref = status.repo!
  const name = PROVIDER_NAMES[ref.kind]

  // The account name is learned when pull requests load (not at startup, to avoid the keychain).
  useEffect(() => {
    if (pulls.isSuccess && status.connected && !status.user) void qc.invalidateQueries({ queryKey: ['provider', repoPath] })
  }, [pulls.isSuccess, status.connected, status.user, qc, repoPath])

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['provider', repoPath] })
    void qc.invalidateQueries({ queryKey: ['pulls', repoPath] })
    void qc.invalidateQueries({ queryKey: ['checks', repoPath] })
    // The clone dialog's account and repository lists depend on which tokens are saved.
    void qc.invalidateQueries({ queryKey: ['provider-accounts'] })
    qc.removeQueries({ queryKey: ['hosted-repos'] })
  }

  const connect = async (): Promise<void> => {
    const help = tokenHelp(ref)
    window.open(help.url, '_blank')
    const token = await ask({
      title: `Connect ${name}`,
      label: `Personal access token for ${ref.host}`,
      confirmLabel: 'Connect',
      secret: true,
      help: `${help.text} Your browser opened the page where you can create one. The token is stored encrypted by your operating system.`,
    })
    if (!token) return
    try {
      const res = await call('provider:connect', { repoPath, token })
      showNotice(`Connected to ${name} as ${res.user}.`)
      refresh()
    } catch (e) {
      showError(e)
    }
  }

  const signIn = async (): Promise<void> => {
    try {
      const { userCode, verificationUri } = await call('provider:signin-start', { repoPath })
      useUiStore.getState().showNotice(`Enter the code ${userCode} on the GitHub page that just opened, then approve GitBob. Waiting…`)
      window.open(verificationUri, '_blank')
      const res = await call('provider:signin-finish', { repoPath })
      showNotice(`Signed in to GitHub as ${res.user}.`)
      refresh()
    } catch (e) {
      showError(e)
    }
  }

  return (
    <section className="mb-1" data-testid="pull-requests">
      <div className="flex items-center pr-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-1 px-3 py-1 text-xs font-semibold tracking-wider text-muted uppercase hover:text-fg"
          aria-expanded={open}
        >
          <span className="inline-block w-3">{open ? '▾' : '▸'}</span>
          Pull requests
          {pulls.data && <span className="ml-auto font-normal">{pulls.data.length}</span>}
        </button>
        {status.connected && (
          <button title="Refresh" aria-label="Refresh pull requests" onClick={refresh} className="ml-1 rounded px-1.5 text-muted hover:bg-panel-2 hover:text-fg">
            ⟳
          </button>
        )}
      </div>
      {open && (
        <div className="pb-1">
          <div className="truncate px-7 text-[11px] text-muted" title={ref.webUrl}>
            {name} · {ref.owner}/{ref.repo}
            {status.user ? ` · ${status.user}` : ''}
          </div>
          {!status.connected ? (
            <div className="px-7 py-1">
              {status.canStoreTokens ? (
                <div className="flex flex-col items-start gap-1">
                  {status.canSignIn && (
                    <button onClick={() => void signIn()} className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-on-accent" data-testid="signin-github">
                      Sign in with GitHub…
                    </button>
                  )}
                  <button onClick={() => void connect()} className="rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2" data-testid="connect-provider">
                    {status.canSignIn ? 'Use an access token…' : `Connect ${name}…`}
                  </button>
                </div>
              ) : (
                <span className="text-xs text-warn">Secure token storage is not available on this system.</span>
              )}
            </div>
          ) : pulls.isPending ? (
            <div className="px-7 py-1 text-xs text-muted">Loading…</div>
          ) : pulls.isError ? (
            <div className="px-7 py-1 text-xs" data-testid="pulls-error">
              <p className="text-err">{pulls.error.message}</p>
              {ref.kind === 'github' && (pulls.error as { code?: string }).code === 'NOT_FOUND' && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {status.canSignIn && (
                    <button
                      className="rounded border border-border px-1.5 py-0.5 hover:bg-panel-2"
                      title="Opens GitHub, where you can request access for an organization"
                      onClick={() => window.open('https://github.com/settings/connections/applications/Ov23liyMamwxTGoZhXPJ', '_blank')}
                    >
                      Request organization access
                    </button>
                  )}
                  <button className="rounded border border-border px-1.5 py-0.5 hover:bg-panel-2" onClick={() => void connect()}>
                    Use an access token…
                  </button>
                </div>
              )}
            </div>
          ) : pulls.data.length === 0 ? (
            <div className="px-7 py-1 text-xs text-muted">No open pull requests</div>
          ) : (
            <ul>
              {pulls.data.map((pr) => {
                const remoteRef = remoteRefs.find((r) => r.name === `refs/remotes/${status.remote}/${pr.sourceBranch}`)
                return (
                  <li key={String(pr.id)}>
                    <button
                      data-testid="pull-request"
                      title={`${pr.title}\n${pr.sourceBranch} → ${pr.targetBranch} · ${pr.author}`}
                      onClick={() => useAppStore.getState().openPr(pr.number)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openMenu(e.clientX, e.clientY, [
                          { label: 'Open in browser', disabled: !/^https?:\/\//i.test(pr.url), onSelect: () => window.open(pr.url, '_blank') },
                          {
                            label: `Check out ${pr.sourceBranch}`,
                            disabled: !remoteRef,
                            onSelect: () => remoteRef && void actions.checkout(remoteRef.name),
                          },
                        ])
                      }}
                      className="flex w-full flex-col items-start py-0.5 pr-3 pl-7 text-left hover:bg-panel-2"
                    >
                      <span className="flex w-full items-center gap-1.5 text-xs">
                        <span className="text-muted">#{pr.number}</span>
                        <span className="truncate">{pr.title}</span>
                        {pr.draft && <span className="ml-auto shrink-0 rounded bg-muted/20 px-1 text-[10px] text-muted">draft</span>}
                      </span>
                      <span className="w-full truncate text-[10px] text-muted">
                        {pr.sourceBranch} → {pr.targetBranch} · {pr.author}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {status.connected && (
            <button
              className="px-7 text-[11px] text-muted hover:text-fg"
              onClick={async () => {
                try {
                  const res = await call('provider:disconnect', { repoPath })
                  if (res.disconnected) refresh()
                } catch (e) {
                  showError(e)
                }
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** Create a pull/merge request for a pushed branch. */
export function CreatePullRequestDialog({
  repoPath,
  providerName,
  branch,
  targets,
  defaultTitle,
  onClose,
}: {
  repoPath: string
  providerName: string
  branch: string
  targets: string[]
  defaultTitle: string
  onClose: () => void
}) {
  const dialogRef = useDialog<HTMLFormElement>(onClose)
  const [title, setTitle] = useState(defaultTitle)
  const [body, setBody] = useState('')
  const [target, setTarget] = useState(targets.find((t) => t === 'main' || t === 'master') ?? targets[0] ?? 'main')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const { showError, showNotice } = useUiStore.getState()
  const qc = useQueryClient()

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const pr = await call('provider:create-pr', { repoPath, title, body, sourceBranch: branch, targetBranch: target, draft })
      void qc.invalidateQueries({ queryKey: ['pulls', repoPath] })
      showNotice(`Pull request #${pr.number} created.`)
      if (/^https?:\/\//i.test(pr.url)) window.open(pr.url, '_blank')
      onClose()
    } catch (e) {
      showError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[10vh]" onMouseDown={onClose}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="Create pull request"
        data-testid="create-pr-dialog"
        className="w-[560px] max-w-[94vw] rounded-lg border border-border bg-panel p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2 className="mb-3 font-semibold">Create pull request on {providerName}</h2>
        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono">{branch}</span>
          <span className="text-muted">into</span>
          <select aria-label="Target branch" value={target} onChange={(e) => setTarget(e.target.value)} className="rounded border border-border bg-bg px-1.5 py-1">
            {targets.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <input
          autoFocus
          aria-label="Pull request title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mb-2 w-full rounded border border-border bg-bg px-2 py-1.5 outline-none focus:border-accent"
        />
        <textarea
          aria-label="Pull request description"
          placeholder="Description (optional)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          className="w-full resize-none rounded border border-border bg-bg px-2 py-1.5 outline-none focus:border-accent"
        />
        <label className="mt-2 flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Create as draft
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded border border-border px-3 py-1 hover:bg-panel-2" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim() || target === branch}
            className="rounded bg-gradient-to-r from-accent to-accent-2 px-3 py-1 font-medium text-on-accent disabled:opacity-40"
          >
            {busy ? 'Creating…' : 'Create pull request'}
          </button>
        </div>
      </form>
    </div>
  )
}

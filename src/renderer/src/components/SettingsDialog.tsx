import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AppSettings } from '@shared/types'
import type { IpcInput } from '@shared/ipc'

/** What the renderer may change (a custom git path is only set via the native picker). */
type SettingsPatch = IpcInput<'settings:update'>['patch']
import { call, subscribe } from '../lib/api'
import { useDialog } from '../lib/useDialog'
import type { Command } from '../lib/commands'
import { eventToAccelerator, formatAccelerator, normalizeAccelerator, RESERVED } from '../lib/shortcuts'
import { useUiStore } from '../state/ui'

type Tab = 'general' | 'git' | 'shortcuts' | 'about'

export function SettingsDialog({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const dialogRef = useDialog<HTMLDivElement>(onClose)
  const [tab, setTab] = useState<Tab>('general')
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => call('settings:get', {}) })
  const info = useQuery({ queryKey: ['app-info'], queryFn: () => call('app:info', {}) })
  const { showError } = useUiStore.getState()

  const update = async (patch: SettingsPatch): Promise<void> => {
    try {
      qc.setQueryData(['settings'], await call('settings:update', { patch }))
      if (patch.gitPath !== undefined) void qc.invalidateQueries({ queryKey: ['app-info'] })
    } catch (e) {
      showError(e)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[8vh]" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="Settings"
        data-testid="settings-dialog"
        className="flex h-[70vh] w-[760px] max-w-[94vw] overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="w-44 shrink-0 border-r border-border bg-panel-2 p-2" aria-label="Settings sections">
          {(
            [
              ['general', 'General'],
              ['git', 'Git'],
              ['shortcuts', 'Keyboard shortcuts'],
              ['about', 'About & updates'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
              className={`mb-0.5 block w-full rounded px-2 py-1.5 text-left text-sm ${tab === id ? 'bg-accent/20 text-fg' : 'text-muted hover:bg-panel'}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex items-center">
            <h2 className="text-lg font-semibold">Settings</h2>
            <button aria-label="Close settings" onClick={onClose} className="ml-auto rounded px-2 text-muted hover:text-fg">
              ✕
            </button>
          </div>
          {!settings.data ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : tab === 'general' ? (
            <General s={settings.data} update={update} />
          ) : tab === 'git' ? (
            <GitTab s={settings.data} update={update} gitPath={info.data?.gitPath} gitVersion={info.data?.gitVersion ?? null} />
          ) : tab === 'shortcuts' ? (
            <Shortcuts s={settings.data} update={update} commands={commands} />
          ) : (
            <About s={settings.data} update={update} version={info.data?.version} />
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-4">
      <div className="w-48 shrink-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function General({ s, update }: { s: AppSettings; update: (p: SettingsPatch) => Promise<void> }) {
  const diffMode = useUiStore((st) => st.diffMode)
  const setDiffMode = useUiStore((st) => st.setDiffMode)
  return (
    <>
      <Row label="Theme">
        <select
          aria-label="Theme"
          value={s.theme}
          onChange={(e) => void update({ theme: e.target.value as AppSettings['theme'] })}
          className="rounded border border-border bg-bg px-2 py-1 text-sm"
        >
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Row>
      <Row label="Diff layout">
        <select
          aria-label="Diff layout"
          value={diffMode}
          onChange={(e) => setDiffMode(e.target.value as 'unified' | 'split')}
          className="rounded border border-border bg-bg px-2 py-1 text-sm"
        >
          <option value="unified">Unified</option>
          <option value="split">Side by side</option>
        </select>
      </Row>
      <Row
        label="GitHub sign-in"
        hint="GitBob's own GitHub app is used on github.com. For GitHub Enterprise or your own OAuth app, enter its client ID (device flow must be enabled)."
      >
        <ClientIdField value={s.githubClientId} onSave={(v) => void update({ githubClientId: v })} />
      </Row>
      <Row
        label="Remember passwords"
        hint="When on, passwords you choose to remember are kept in your system's secure credential store."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={s.usePlatformCredentialHelper}
            onChange={(e) => void update({ usePlatformCredentialHelper: e.target.checked })}
          />
          Use the system keychain for Git credentials
        </label>
      </Row>
    </>
  )
}

function GitTab({
  s,
  update,
  gitPath,
  gitVersion,
}: {
  s: AppSettings
  update: (p: SettingsPatch) => Promise<void>
  gitPath: string | undefined
  gitVersion: string | null
}) {
  const qc = useQueryClient()
  const { showError } = useUiStore.getState()
  return (
    <Row label="Git program" hint="GitBob runs this Git for every operation.">
      <div className="mb-2 font-mono text-xs" data-testid="git-path">
        {gitPath ?? '…'} {gitVersion ? <span className="text-muted">(version {gitVersion})</span> : <span className="text-err">(not working)</span>}
      </div>
      <div className="flex gap-2">
        <button
          className="rounded border border-border px-2 py-1 text-sm hover:bg-panel-2"
          onClick={async () => {
            try {
              const res = await call('app:pick-git', {})
              if (res) {
                void qc.invalidateQueries({ queryKey: ['settings'] })
                void qc.invalidateQueries({ queryKey: ['app-info'] })
              }
            } catch (e) {
              showError(e)
            }
          }}
        >
          Choose…
        </button>
        {s.gitPath && (
          <button className="rounded border border-border px-2 py-1 text-sm hover:bg-panel-2" onClick={() => void update({ gitPath: null })}>
            Use Git from PATH
          </button>
        )}
      </div>
    </Row>
  )
}

function Shortcuts({
  s,
  update,
  commands,
}: {
  s: AppSettings
  update: (p: SettingsPatch) => Promise<void>
  commands: Command[]
}) {
  const [recording, setRecording] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const effective = (c: Command): string | undefined => s.shortcuts[c.id] || c.defaultShortcut

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        Click a shortcut, then press the new key combination. Escape cancels; Backspace removes it.
      </p>
      {problem && (
        <p role="alert" className="mb-2 text-xs text-err">
          {problem}
        </p>
      )}
      <table className="w-full text-sm" data-testid="shortcuts-table">
        <tbody>
          {commands.map((c) => {
            const acc = effective(c)
            return (
              <tr key={c.id} className="border-b border-border">
                <td className="py-1.5 pr-2 text-xs text-muted">{c.section}</td>
                <td className="py-1.5">{c.title}</td>
                <td className="py-1.5 text-right">
                  <button
                    data-testid={`shortcut-${c.id}`}
                    aria-label={`Shortcut for ${c.title}`}
                    onClick={() => {
                      setProblem(null)
                      setRecording(c.id)
                    }}
                    onKeyDown={(e) => {
                      if (recording !== c.id) return
                      e.preventDefault()
                      e.stopPropagation()
                      if (e.key === 'Escape') return setRecording(null)
                      if (e.key === 'Backspace') {
                        setRecording(null)
                        return void update({ shortcuts: { ...s.shortcuts, [c.id]: '' } })
                      }
                      const raw = eventToAccelerator(e)
                      if (!raw) return
                      const next = normalizeAccelerator(raw)
                      if (!next.includes('Mod') && !next.includes('Alt') && !next.includes('Ctrl')) {
                        return setProblem('Use at least one of ⌘/Ctrl or Alt so typing is not affected.')
                      }
                      if (RESERVED.includes(next)) return setProblem(`${formatAccelerator(next)} is used by the menu.`)
                      const clash = commands.find((o) => o.id !== c.id && effective(o) && normalizeAccelerator(effective(o)!) === next)
                      if (clash) return setProblem(`${formatAccelerator(next)} is already used by “${clash.title}”.`)
                      setRecording(null)
                      void update({ shortcuts: { ...s.shortcuts, [c.id]: next } })
                    }}
                    onBlur={() => recording === c.id && setRecording(null)}
                    className={`min-w-24 rounded border px-2 py-0.5 text-xs ${recording === c.id ? 'border-accent text-accent' : 'border-border text-muted hover:text-fg'}`}
                  >
                    {recording === c.id ? 'Press keys…' : acc ? formatAccelerator(acc) : '—'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {Object.keys(s.shortcuts).length > 0 && (
        <button className="mt-3 rounded border border-border px-2 py-1 text-xs hover:bg-panel-2" onClick={() => void update({ shortcuts: {} })}>
          Restore default shortcuts
        </button>
      )}
    </div>
  )
}

function About({ s, update, version }: { s: AppSettings; update: (p: SettingsPatch) => Promise<void>; version: string | undefined }) {
  const [result, setResult] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [canInstall, setCanInstall] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [downloaded, setDownloaded] = useState<string | null>(null)
  useEffect(() => subscribe('app:update-progress', (p) => setProgress(p.percent)), [])
  useEffect(() => subscribe('app:update-downloaded', (d) => setDownloaded(d.version)), [])
  return (
    <>
      <Row label="Version">
        <span className="font-mono text-sm" data-testid="app-version">
          GitBob {version ?? '…'}
        </span>
      </Row>
      <Row label="Updates" hint="Checking contacts GitHub (api.github.com). Nothing else is sent.">
        <label className="mb-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.autoCheckUpdates} onChange={(e) => void update({ autoCheckUpdates: e.target.checked })} />
          Check for updates when GitBob starts
        </label>
        <button
          disabled={checking}
          className="rounded border border-border px-2 py-1 text-sm hover:bg-panel-2 disabled:opacity-50"
          onClick={async () => {
            setChecking(true)
            try {
              const u = await call('app:check-update', {})
              setResult(
                u.newer
                  ? `GitBob ${u.latest} is available.`
                  : u.latest
                    ? `You have the latest version (${u.current}).`
                    : 'No published releases yet.',
              )
              setCanInstall(!!u.canInstall)
              // Without in-app installation (macOS until signed builds, Linux .deb, dev builds): open the release page.
              if (u.newer && !u.canInstall && u.url) window.open(u.url, '_blank')
            } catch (e) {
              setResult(e instanceof Error ? e.message : String(e))
            } finally {
              setChecking(false)
            }
          }}
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
        {result && <p className="mt-2 text-sm" data-testid="update-result">{result}</p>}
        {canInstall && !downloaded && (
          <button
            disabled={progress !== null}
            className="mt-2 rounded bg-accent px-2 py-1 text-sm font-medium text-on-accent disabled:opacity-60"
            onClick={async () => {
              setProgress(0)
              try {
                await call('app:download-update', {})
              } catch (e) {
                setProgress(null)
                setResult(e instanceof Error ? e.message : String(e))
              }
            }}
          >
            {progress === null ? 'Download and install' : `Downloading… ${progress}%`}
          </button>
        )}
        {downloaded && (
          <button
            className="mt-2 rounded bg-accent px-2 py-1 text-sm font-medium text-on-accent"
            onClick={() => void call('app:install-update', {})}
          >
            Restart and install {downloaded}
          </button>
        )}
      </Row>
      <Row label="Source code">
        <a href="https://github.com/szabto/gitbob" target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
          github.com/szabto/gitbob
        </a>
        <span className="ml-2 text-xs text-muted">MIT License</span>
      </Row>
    </>
  )
}

function ClientIdField({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [text, setText] = useState(value ?? '')
  const valid = text === '' || /^[A-Za-z0-9._-]{8,64}$/.test(text)
  return (
    <div className="flex gap-2">
      <input
        aria-label="GitHub OAuth client ID"
        value={text}
        onChange={(e) => setText(e.target.value.trim())}
        placeholder="Built-in (github.com)"
        className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-sm"
      />
      <button
        disabled={!valid || text === (value ?? '')}
        onClick={() => onSave(text || null)}
        className="rounded border border-border px-2 py-1 text-sm hover:bg-panel-2 disabled:opacity-40"
      >
        Save
      </button>
    </div>
  )
}

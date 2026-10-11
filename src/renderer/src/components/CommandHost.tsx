import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RepositoryInfo } from '@shared/types'
import { call, subscribe } from '../lib/api'
import { useRepoActions } from '../lib/actions'
import { useCommands, type CommandContext } from '../lib/commands'
import { useHead, useRecent, useRefs, useRemotes, useUndoState } from '../lib/queries'
import { eventToAccelerator, normalizeAccelerator } from '../lib/shortcuts'
import { useAppStore } from '../state/store'
import { useUiStore } from '../state/ui'
import { CommandPalette, commandToItem, type PaletteItem } from './CommandPalette'
import { SettingsDialog, type SettingsTab } from './SettingsDialog'

/** Owns the command palette, settings dialog and global keyboard shortcuts. */
export function CommandHost({
  repo,
  app,
}: {
  repo: RepositoryInfo | null
  app: Omit<CommandContext['app'], 'openSettings' | 'setTheme' | 'focusSearch'>
}) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const repoPath = repo?.root ?? ''
  const actions = useRepoActions(repoPath)
  const head = useHead(repoPath, !!repo)
  const refs = useRefs(repoPath, !!repo)
  const remotes = useRemotes(repoPath, !!repo)
  const undoState = useUndoState(repoPath, !!repo)
  const recent = useRecent()
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => call('settings:get', {}) })
  const showNotice = useUiStore((s) => s.showNotice)

  useEffect(() => subscribe('menu:command-palette', () => setPaletteOpen(true)), [])
  useEffect(() => {
    const open = (): void => setPaletteOpen(true)
    const settings = (e: Event): void => {
      setSettingsTab((e as CustomEvent<SettingsTab | undefined>).detail ?? 'general')
      setSettingsOpen(true)
    }
    window.addEventListener('gitbob:command-palette', open)
    window.addEventListener('gitbob:open-settings', settings)
    return () => {
      window.removeEventListener('gitbob:command-palette', open)
      window.removeEventListener('gitbob:open-settings', settings)
    }
  }, [])
  useEffect(() => subscribe('menu:settings', () => setSettingsOpen(true)), [])
  useEffect(() => subscribe('settings:changed', (s) => qc.setQueryData(['settings'], s)), [qc])
  useEffect(
    () =>
      subscribe('app:update-available', (u) =>
        showNotice(`GitBob ${u.latest} is available. Open Settings → About & updates to get it.`),
      ),
    [showNotice],
  )

  const setTheme = useCallback(
    (theme: 'system' | 'light' | 'dark') => void call('settings:update', { patch: { theme } }),
    [],
  )
  const focusSearch = useCallback(() => {
    const el = document.getElementById('graph-search-input') as HTMLInputElement | null
    el?.focus()
    el?.select()
  }, [])

  const currentRef = refs.data?.find((r) => r.name === head.data?.ref)
  const ctx = useMemo<CommandContext>(
    () => ({
      repo,
      actions: repo ? actions : null,
      headSha: head.data?.sha ?? null,
      currentRef,
      remotes: (remotes.data ?? []).map((r) => r.name),
      undo: undoState.data ?? { undo: null, redo: null },
      app: { ...app, openSettings: () => setSettingsOpen(true), setTheme, focusSearch },
    }),
    // actions is a fresh object each render; its identity doesn't matter for the command list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, head.data?.sha, currentRef, remotes.data, undoState.data, app, setTheme, focusSearch],
  )
  const commands = useCommands(ctx)
  const overrides = settings.data?.shortcuts
  const shortcutOf = useCallback(
    (id: string, def?: string): string | undefined => {
      const o = overrides?.[id]
      return o === '' ? undefined : (o ?? def)
    },
    [overrides],
  )

  // Global shortcuts. Native menu accelerators (⌘O, ⌘K, ⌘, …) are handled by the menu itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (paletteOpen || settingsOpen) return
      const raw = eventToAccelerator(e)
      if (!raw) return
      const acc = normalizeAccelerator(raw)
      const cmd = commands.find((c) => {
        const s = shortcutOf(c.id, c.defaultShortcut)
        return s && normalizeAccelerator(s) === acc
      })
      if (!cmd || cmd.disabled) return
      e.preventDefault()
      cmd.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commands, shortcutOf, paletteOpen, settingsOpen])

  const items = useMemo<PaletteItem[]>(() => {
    const list = commands.map((c) => commandToItem(c, shortcutOf(c.id, c.defaultShortcut)))
    if (repo && !repo.bare) {
      for (const r of refs.data ?? []) {
        if (r.kind !== 'head' && r.kind !== 'remote') continue
        if (r.name === head.data?.ref) continue
        list.push({ id: `checkout:${r.name}`, title: `Check out ${r.shortName}`, section: 'Branch', run: () => void actions.checkout(r.name) })
      }
    }
    for (const r of recent.data ?? []) {
      if (r.path === repo?.root) continue
      list.push({
        id: `open:${r.path}`,
        title: `Open ${r.name}`,
        section: 'Recent',
        run: () => void call('repo:open', { path: r.path }).then((info) => useAppStore.getState().setRepo(info)),
      })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, shortcutOf, repo, refs.data, head.data?.ref, recent.data])

  return (
    <>
      {paletteOpen && <CommandPalette items={items} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && <SettingsDialog commands={commands} initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />}
    </>
  )
}

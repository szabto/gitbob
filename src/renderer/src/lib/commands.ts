import { useMemo } from 'react'
import type { GitRef, RepositoryInfo } from '@shared/types'
import type { useRepoActions } from './actions'
import { useAppStore } from '../state/store'

export interface Command {
  id: string
  title: string
  /** Group shown in the palette. */
  section: 'Repository' | 'Branch' | 'Changes' | 'View' | 'App'
  defaultShortcut?: string
  run: () => void
  disabled?: boolean
}

export interface CommandContext {
  repo: RepositoryInfo | null
  actions: ReturnType<typeof useRepoActions> | null
  headSha: string | null
  currentRef: GitRef | undefined
  remotes: string[]
  app: {
    openRepository: () => void
    cloneRepository: () => void
    initRepository: () => void
    openSettings: () => void
    setTheme: (t: 'system' | 'light' | 'dark') => void
    focusSearch: () => void
  }
}

/** All commands available in the current context (palette + shortcuts share this list). */
export function useCommands(ctx: CommandContext): Command[] {
  return useMemo(() => {
    const { repo, actions: a, app } = ctx
    const store = useAppStore.getState()
    const noRepo = !repo
    const list: Command[] = [
      { id: 'app.open', title: 'Open repository…', section: 'App', run: app.openRepository },
      { id: 'app.clone', title: 'Clone repository…', section: 'App', run: app.cloneRepository },
      { id: 'app.init', title: 'New repository…', section: 'App', run: app.initRepository },
      { id: 'app.settings', title: 'Settings…', section: 'App', run: app.openSettings },
      { id: 'app.new-tab', title: 'New tab', section: 'App', defaultShortcut: 'Mod+T', run: () => store.newTab() },
      {
        id: 'app.close-tab',
        title: 'Close tab',
        section: 'App',
        defaultShortcut: 'Mod+Shift+W',
        disabled: noRepo,
        run: () => repo && store.closeTab(repo.root),
      },
      { id: 'view.theme-light', title: 'Theme: Light', section: 'View', run: () => app.setTheme('light') },
      { id: 'view.theme-dark', title: 'Theme: Dark', section: 'View', run: () => app.setTheme('dark') },
      { id: 'view.theme-system', title: 'Theme: Match system', section: 'View', run: () => app.setTheme('system') },
      { id: 'view.search', title: 'Search history', section: 'View', defaultShortcut: 'Mod+F', disabled: noRepo, run: app.focusSearch },
      {
        id: 'view.wip',
        title: 'Show working changes',
        section: 'Changes',
        defaultShortcut: 'Mod+Shift+C',
        disabled: noRepo || repo.bare,
        run: () => store.selectWip(),
      },
      {
        id: 'view.clear-filter',
        title: 'Clear graph filter',
        section: 'View',
        disabled: noRepo,
        run: () => store.setHistoryFilter(null),
      },
    ]
    if (a && repo && !repo.bare) {
      list.push(
        { id: 'repo.fetch', title: 'Fetch', section: 'Repository', defaultShortcut: 'Mod+Shift+F', disabled: ctx.remotes.length === 0, run: () => void a.fetch() },
        { id: 'repo.pull', title: 'Pull (fast-forward only)', section: 'Repository', defaultShortcut: 'Mod+Shift+L', disabled: !ctx.currentRef?.upstream, run: () => void a.pull('ff-only') },
        { id: 'repo.pull-merge', title: 'Pull (merge)', section: 'Repository', disabled: !ctx.currentRef?.upstream, run: () => void a.pull('merge') },
        { id: 'repo.pull-rebase', title: 'Pull (rebase)', section: 'Repository', disabled: !ctx.currentRef?.upstream, run: () => void a.pull('rebase') },
        { id: 'repo.push', title: 'Push', section: 'Repository', defaultShortcut: 'Mod+Shift+P', disabled: !ctx.currentRef, run: () => void a.push(ctx.currentRef, ctx.remotes) },
        { id: 'branch.create', title: 'Create branch…', section: 'Branch', defaultShortcut: 'Mod+B', disabled: !ctx.headSha, run: () => ctx.headSha && void a.createBranch(ctx.headSha) },
        { id: 'changes.stash', title: 'Stash changes…', section: 'Changes', defaultShortcut: 'Mod+Shift+S', disabled: !ctx.headSha, run: () => void a.stash() },
        { id: 'repo.add-remote', title: 'Add remote…', section: 'Repository', run: () => void a.addRemote() },
        { id: 'repo.add-worktree', title: 'Add worktree…', section: 'Repository', run: () => void a.addWorktree() },
      )
    }
    return list
  }, [ctx])
}

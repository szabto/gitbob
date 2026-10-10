import { call } from './api'
import { useInvalidateRepo } from './queries'
import { useUiStore } from '../state/ui'
import { useCallback } from 'react'
import type { GitRef } from '@shared/types'

/**
 * Repository actions shared by the toolbar, sidebar and graph context menus.
 * Every action reports failures through the global error banner and refreshes
 * repository state afterwards.
 */
export function useRepoActions(repoPath: string) {
  const invalidate = useInvalidateRepo(repoPath)
  const { showError, ask, setBusy } = useUiStore.getState()

  const run = useCallback(
    async <T,>(label: string | null, fn: () => Promise<T>): Promise<T | undefined> => {
      if (label) setBusy(label)
      try {
        return await fn()
      } catch (e) {
        // A user-initiated cancel is not an error worth a banner.
        if (!(e instanceof Error && 'code' in e && (e as { code: string }).code === 'CANCELLED')) showError(e)
        return undefined
      } finally {
        if (label) setBusy(null)
        invalidate()
      }
    },
    [invalidate, showError, setBusy],
  )

  return {
    fetch: () => run('Fetching…', () => call('remote:fetch', { repoPath, prune: true })),
    pull: (mode: 'ff-only' | 'merge' | 'rebase') => run('Pulling…', () => call('remote:pull', { repoPath, mode })),
    push: async (branch: GitRef | undefined, remotes: string[]) => {
      if (!branch) {
        showError(new Error('Push requires a checked out local branch.'))
        return
      }
      let remote = branch.upstream?.match(/^refs\/remotes\/([^/]+)\//)?.[1]
      let setUpstream = false
      if (!remote) {
        if (remotes.length === 0) {
          showError(new Error('This repository has no remotes. Add one first.'))
          return
        }
        const picked =
          remotes.length === 1
            ? remotes[0]!
            : await ask({ title: `Push ${branch.shortName}`, label: 'Remote', choices: remotes, confirmLabel: 'Push' })
        if (!picked) return
        remote = picked
        setUpstream = true
      }
      const r = remote
      await run('Pushing…', () => call('remote:push', { repoPath, branch: branch.shortName, remote: r, setUpstream }))
    },
    forcePush: (branch: GitRef, remote: string) =>
      run('Pushing…', () =>
        call('remote:push', { repoPath, branch: branch.shortName, remote, setUpstream: false, force: 'with-lease' }),
      ),
    createBranch: async (startPoint: string, checkout = true) => {
      const name = await ask({ title: 'Create branch', label: 'Branch name', confirmLabel: 'Create', placeholder: 'feature/my-change' })
      if (name) await run(null, () => call('branch:create', { repoPath, name, startPoint, checkout }))
    },
    checkout: (ref: string) => run(null, () => call('branch:checkout', { repoPath, ref })),
    checkoutCommit: (sha: string) => run(null, () => call('commit:checkout', { repoPath, sha })),
    rename: async (name: string) => {
      const newName = await ask({ title: `Rename ${name}`, label: 'New name', initialValue: name, confirmLabel: 'Rename' })
      if (newName && newName !== name) await run(null, () => call('branch:rename', { repoPath, oldName: name, newName }))
    },
    deleteBranch: async (name: string) => {
      try {
        await call('branch:delete', { repoPath, name, force: false })
        invalidate()
      } catch (e) {
        if (e instanceof Error && /not fully merged/.test(e.message)) {
          // Main shows a second, explicit confirmation for the forced delete.
          await run(null, () => call('branch:delete', { repoPath, name, force: true }))
        } else showError(e)
      }
    },
    setUpstream: async (name: string, remoteBranches: string[]) => {
      if (remoteBranches.length === 0) {
        showError(new Error('There are no remote branches to track. Fetch or push first.'))
        return
      }
      const upstream = await ask({ title: `Set upstream for ${name}`, label: 'Remote branch', choices: remoteBranches, confirmLabel: 'Set upstream' })
      if (upstream) await run(null, () => call('branch:set-upstream', { repoPath, name, upstream }))
    },
    unsetUpstream: (name: string) => run(null, () => call('branch:set-upstream', { repoPath, name, upstream: null })),
    addRemote: async () => {
      const name = await ask({ title: 'Add remote', label: 'Name', initialValue: 'origin', confirmLabel: 'Next' })
      if (!name) return
      const url = await ask({ title: `Add remote ${name}`, label: 'URL', placeholder: 'git@github.com:owner/repo.git', confirmLabel: 'Add' })
      if (url) await run(null, () => call('remote:add', { repoPath, name, url }))
    },
    removeRemote: (name: string) => run(null, () => call('remote:remove', { repoPath, name })),
  }
}

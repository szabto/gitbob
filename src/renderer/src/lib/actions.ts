import { call } from './api'
import { useInvalidateRepo } from './queries'
import { useUiStore } from '../state/ui'
import { useAppStore } from '../state/store'
import { useCallback } from 'react'
import type { CommitSummary, GitRef } from '@shared/types'

/**
 * Repository actions shared by the toolbar, sidebar and graph context menus.
 * Every action reports failures through the global error banner and refreshes
 * repository state afterwards.
 */
export function useRepoActions(repoPath: string) {
  const invalidate = useInvalidateRepo(repoPath)
  const { showError, showNotice, ask, setBusy } = useUiStore.getState()

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

  /**
   * Rewrite the current branch from `commit`'s parent (or grandparent with depth 2) through an
   * interactive rebase whose plan `transform` edits.
   */
  const rewrite = (commit: CommitSummary, transform: (todo: { sha: string; action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'; message?: string }[]) => { sha: string; action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'; message?: string }[], depth: 1 | 2 = 1) =>
    run('Rewriting history…', async () => {
      let base = commit.parents[0]
      if (!base) throw new Error('The first commit of the history can’t be changed this way.')
      if (depth === 2) {
        const parent = await call('commit:details', { repoPath, sha: base })
        base = parent.parents[0]
        if (!base) throw new Error('This is already the oldest commit that can be moved.')
      }
      const commits = await call('rebase:todo', { repoPath, base })
      const todo = transform(commits.map((c) => ({ sha: c.sha, action: 'pick' as const })))
      const r = await call('rebase:start', { repoPath, base, todo })
      if (r.completed) showNotice('History rewritten. Undo can take it back.')
    })

  return {
    undo: () =>
      run('Undoing…', async () => {
        const r = await call('undo:undo', { repoPath })
        showNotice(`Undid: ${r.label}`)
      }),
    redo: () =>
      run('Redoing…', async () => {
        const r = await call('undo:redo', { repoPath })
        showNotice(`Redid: ${r.label}`)
      }),
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

    // Worktrees and submodules
    openRepositoryAt: async (path: string) => {
      try {
        useAppStore.getState().setRepo(await call('repo:open', { path }))
      } catch (e) {
        showError(e)
      }
    },
    /** Worktree with an existing local branch checked out. */
    addWorktreeForBranch: async (branch: string) => {
      const res = await run(null, () => call('worktree:add', { repoPath, branch }))
      if (res) showNotice(`Worktree created at ${res.path}. Open it from the Worktrees list.`)
    },
    addWorktree: async (startPoint?: string) => {
      const name = await ask({
        title: 'New worktree',
        label: 'New branch for the worktree (leave empty for a detached checkout)',
        placeholder: 'feature/side-task',
        confirmLabel: 'Choose folder…',
        allowEmpty: true,
      })
      if (name === null) return
      const res = await run(null, () => call('worktree:add', { repoPath, ...(name ? { newBranch: name } : {}), ...(startPoint ? { startPoint } : {}) }))
      if (res) showNotice(`Worktree created at ${res.path}. Open it from the Worktrees list.`)
    },
    removeWorktree: (path: string, force = false) =>
      run(null, () => call('worktree:remove', { repoPath, path, force })),
    updateSubmodules: (paths?: string[]) =>
      run('Updating submodules…', () => call('submodule:update', { repoPath, ...(paths ? { paths } : {}) })),

    // Stash
    stash: async () => {
      const message = await ask({
        title: 'Stash changes',
        label: 'Message (optional)',
        placeholder: 'What were you working on?',
        confirmLabel: 'Stash',
        allowEmpty: true,
      })
      if (message === null) return
      const res = await run(null, () => call('stash:create', { repoPath, message, includeUntracked: true }))
      if (res && !res.created) showNotice('There were no local changes to stash.')
    },
    stashFiles: async (paths: string[]) => {
      const message = await ask({
        title: paths.length === 1 ? `Stash ${paths[0]}` : `Stash ${paths.length} files`,
        label: 'Message (optional)',
        placeholder: 'What were you working on?',
        confirmLabel: 'Stash',
        allowEmpty: true,
      })
      if (message === null) return
      const res = await run(null, () => call('stash:create', { repoPath, message, includeUntracked: true, paths }))
      if (res && !res.created) showNotice('There were no local changes to stash.')
    },
    stashToBranch: async (s: { index: number; sha: string }) => {
      const name = await ask({ title: 'Create branch from stash', label: 'Branch name', confirmLabel: 'Create branch' })
      if (!name) return false
      const ok = await run(null, async () => {
        await call('stash:branch', { repoPath, index: s.index, sha: s.sha, name })
        showNotice(`Created ${name} with the stashed changes. The stash was removed.`)
        return true
      })
      return ok === true
    },
    applyStashFile: (s: { index: number; sha: string }, path: string) =>
      run(null, async () => {
        await call('stash:apply-file', { repoPath, index: s.index, sha: s.sha, path })
        showNotice(`Restored ${path} from the stash. The stash was kept.`)
      }),
    applyStash: (s: { index: number; sha: string }, pop: boolean) =>
      run(null, () => call('stash:apply', { repoPath, index: s.index, sha: s.sha, pop })),
    dropStash: (s: { index: number; sha: string }) =>
      run(null, () => call('stash:drop', { repoPath, index: s.index, sha: s.sha })),

    // Tags
    createTag: async (target: string, annotated = false) => {
      const name = await ask({ title: annotated ? 'Create annotated tag' : 'Create tag', label: 'Tag name', placeholder: 'v1.0.0', confirmLabel: annotated ? 'Next' : 'Create tag' })
      if (!name) return
      let message = ''
      if (annotated) {
        const m = await ask({ title: `Annotated tag ${name}`, label: 'Message', confirmLabel: 'Create tag', multiline: true })
        if (!m) return
        message = m
      }
      await run(null, () => call('tag:create', { repoPath, name, target, ...(message ? { message } : {}) }))
    },
    copy: async (text: string, what: string) => {
      try {
        await call('app:copy', { text })
        showNotice(`Copied ${what}.`)
      } catch (e) {
        showError(e)
      }
    },
    /** Change a commit's message: HEAD is amended (message only); older commits are reworded by a rebase. */
    rewordCommit: async (commit: CommitSummary, headSha: string | null) => {
      const details = await call('commit:details', { repoPath, sha: commit.sha }).catch(() => null)
      const current = details ? (details.body ? `${details.subject}\n\n${details.body}` : details.subject) : commit.subject
      const message = await ask({ title: `Edit message of ${commit.sha.slice(0, 7)}`, label: 'Commit message', initialValue: current, multiline: true, confirmLabel: 'Save message' })
      if (!message || message === current) return
      if (commit.sha === headSha) return run('Saving…', () => call('commit:reword-head', { repoPath, message }))
      return rewrite(commit, (todo) => todo.map((t) => (t.sha === commit.sha ? { sha: t.sha, action: 'reword' as const, message } : t)))
    },
    dropCommit: async (commit: CommitSummary) => {
      const ok = await call('app:confirm', {
        message: `Drop commit “${commit.subject}”?`,
        detail: 'The commit is removed from the current branch and later commits are rewritten. Undo can bring it back.',
        confirmLabel: 'Drop commit',
      })
      if (ok) return rewrite(commit, (todo) => todo.map((t) => (t.sha === commit.sha ? { ...t, action: 'drop' as const } : t)))
    },
    /** Swap a commit with its child (up) or parent (down) on the current branch. */
    moveCommit: (commit: CommitSummary, dir: 'up' | 'down') =>
      rewrite(
        commit,
        (todo) => {
          const i = todo.findIndex((t) => t.sha === commit.sha)
          const j = dir === 'up' ? i + 1 : i - 1
          if (i < 0 || j < 0 || j >= todo.length) throw new Error(dir === 'up' ? 'This is already the newest commit.' : 'This is already the oldest commit that can be moved.')
          const next = [...todo]
          ;[next[i], next[j]] = [next[j]!, next[i]!]
          return next
        },
        dir === 'down' ? 2 : 1,
      ),
    rebaseOntoCommit: (sha: string) =>
      run('Rebasing…', async () => {
        const r = await call('branch:rebase', { repoPath, onto: sha })
        if (r.done) showNotice(`Rebased onto ${sha.slice(0, 7)}.`)
      }),
    fastForward: (branch: string, to: string, toLabel: string) =>
      run(null, async () => {
        const r = await call('branch:fast-forward', { repoPath, branch, to })
        showNotice(r.moved ? `Fast-forwarded ${branch} to ${toLabel}.` : `${branch} is already at ${toLabel}.`)
      }),
    pullBranch: (branch: string) =>
      run('Pulling…', async () => {
        const r = await call('branch:pull-other', { repoPath, branch })
        showNotice(r.moved ? `${branch} is up to date with its upstream now.` : `${branch} was already up to date.`)
      }),
    /** Check out `target` and merge `source` into it. */
    mergeInto: (target: GitRef, source: GitRef) =>
      run('Merging…', async () => {
        await call('branch:checkout', { repoPath, ref: target.name })
        const r = await call('branch:merge', { repoPath, ref: source.name, mode: 'ff' })
        showNotice(r.upToDate ? `${target.shortName} already contains ${source.shortName}.` : `Merged ${source.shortName} into ${target.shortName}.`)
      }),
    deleteRemoteBranch: (ref: GitRef) => {
      const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref.name)
      if (!m) return Promise.resolve(undefined)
      return run('Deleting…', async () => {
        const r = await call('branch:delete-remote', { repoPath, remote: m[1]!, branch: m[2]! })
        if (r.deleted) showNotice(`Deleted ${ref.shortName} on ${m[1]}.`)
      })
    },
    savePatch: (sha: string) =>
      run(null, async () => {
        const r = await call('commit:save-patch', { repoPath, sha })
        if (r) showNotice(`Saved ${r.path}`)
      }),
    deleteTag: (name: string) => run(null, () => call('tag:delete', { repoPath, name })),
    pushTag: async (name: string, remotes: string[]) => {
      if (remotes.length === 0) {
        showError(new Error('This repository has no remotes.'))
        return
      }
      const remote =
        remotes.length === 1
          ? remotes[0]!
          : await ask({ title: `Push tag ${name}`, label: 'Remote', choices: remotes, confirmLabel: 'Push' })
      if (remote) await run('Pushing tag…', () => call('tag:push', { repoPath, name, remote }))
    },

    // History
    reset: async (target: string, mode: 'soft' | 'mixed' | 'hard') => {
      const res = await run(null, () => call('history:reset', { repoPath, target, mode }))
      if (res?.done && res.backupStash) {
        showNotice(
          `Your uncommitted changes were saved as a backup stash (${res.backupStash.slice(0, 7)}). Find it under Stashes to restore them.`,
        )
      }
    },
    revert: (sha: string) => run(null, () => call('history:revert', { repoPath, sha })),
    cherryPick: (sha: string) => run(null, () => call('history:cherry-pick', { repoPath, shas: [sha] })),
    merge: (ref: GitRef, mode: 'ff' | 'no-ff' | 'ff-only' = 'ff') =>
      run('Merging…', async () => {
        const r = await call('branch:merge', { repoPath, ref: ref.name, mode })
        showNotice(r.upToDate ? `Already up to date with ${ref.shortName}.` : r.fastForward ? `Fast-forwarded to ${ref.shortName}.` : `Merged ${ref.shortName}.`)
      }),
    rebase: (onto: GitRef) =>
      run('Rebasing…', async () => {
        const r = await call('branch:rebase', { repoPath, onto: onto.name })
        if (r.done) showNotice(`Rebased onto ${onto.shortName}.`)
      }),
    continueOperation: () => run(null, () => call('op:continue', { repoPath })),
    abortOperation: () => run(null, () => call('op:abort', { repoPath })),
    skipOperation: () => run(null, () => call('op:skip', { repoPath })),
  }
}

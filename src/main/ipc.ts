import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type IpcChannel } from '@shared/channels'
import { ipcInputSchemas } from '@shared/ipc'
import type { IpcOutputs } from '@shared/ipc-types'
import type { Result } from '@shared/result'
import type { AppSettings, RepositoryInfo } from '@shared/types'
import { GitError, toAppError } from '@git-core/errors'
import { openRepository } from '@git-core/repository'
import { getHead, listRefs } from '@git-core/refs'
import { getCommitPage } from '@git-core/log'
import { cloneRepository, initRepository } from '@git-core/create'
import { getCommitDetails } from '@git-core/details'
import { searchCommits } from '@git-core/search'
import { getStatus } from '@git-core/status'
import { discardPaths, stageAll, stagePaths, unstageAll, unstagePaths } from '@git-core/staging'
import { getFileDiff } from '@git-core/diff'
import { getFileContents } from '@git-core/contents'
import { applyHunks } from '@git-core/patch'
import { describeConflict, getConflictVersions, resolveConflictWith, saveConflictResolution } from '@git-core/conflicts'
import { getLfsStatus, installLfs, pullLfs, trackPattern, untrackPattern } from '@git-core/lfs'
import { createCommit, getLastCommitMessage } from '@git-core/commit'
import {
  checkoutDetached,
  checkoutRef,
  createBranch,
  deleteBranch,
  renameBranch,
  setUpstream,
} from '@git-core/branches'
import { addRemote, fetch, listRemotes, pull, push, removeRemote, type NetworkOptions } from '@git-core/remotes'
import type { NetworkSession } from './network'
import type { ProviderService } from './providers'
import { appInfo, gitIdentity, setGitIdentity, validateGitPath } from './app-info'
import type { Updater } from './updater'
import { applyStash, createStash, dropStash, getStashFiles, listStashes } from '@git-core/stash'
import { createTag, deleteTag, listTags, pushTag } from '@git-core/tags'
import { abortOperation, cherryPick, continueOperation, reset, revert, skipOperation } from '@git-core/history'
import { getReflog } from '@git-core/reflog'
import { cleanupRebaseFiles, getRebaseTodo, interactiveRebase } from '@git-core/rebase'
import { getBlame } from '@git-core/blame'
import { addWorktree, listWorktrees, removeWorktree } from '@git-core/worktrees'
import { listSubmodules, updateSubmodules } from '@git-core/submodules'
import { getSignature } from '@git-core/signatures'
import type { RecentRepositoryStore } from './recent'
import { z } from 'zod'

type Handler<C extends IpcChannel> = (
  input: z.output<(typeof ipcInputSchemas)[C]>,
  event: IpcMainInvokeEvent,
) => Promise<IpcOutputs[C]>

export interface IpcContext {
  recent: RecentRepositoryStore
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  /** Called whenever a repository is opened (e.g. to start watching it). */
  onRepositoryOpened?: (info: RepositoryInfo) => void
  network: NetworkSession
  getSettings: () => AppSettings
  /** Validate and apply a settings change (theme, git path, …); returns the new settings. */
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  providers: ProviderService
  updater: Updater
}

/**
 * Repositories the user explicitly opened in this session. Every repository
 * scoped call must target one of these, so a compromised renderer cannot
 * point Git at arbitrary directories.
 */
const openedRepos = new Map<string, RepositoryInfo>()

function requireOpened(repoPath: string): string {
  if (!openedRepos.has(repoPath)) {
    throw new GitError('INVALID_ARGUMENT', 'Repository has not been opened in this session')
  }
  return repoPath
}

export async function openAndRegister(path: string, ctx: IpcContext): Promise<RepositoryInfo> {
  const info = await openRepository(path)
  openedRepos.set(info.root, info)
  ctx.onRepositoryOpened?.(info)
  await ctx.recent.add(info.root, info.name).catch(() => {
    /* recents are best-effort */
  })
  return info
}

async function pickFolder(event: IpcMainInvokeEvent, title: string, buttonLabel: string): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const opts = { title, buttonLabel, properties: ['openDirectory' as const, 'createDirectory' as const] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const picked = res.filePaths[0]
  return res.canceled || !picked ? null : picked
}

async function confirmDestructive(
  event: IpcMainInvokeEvent,
  opts: { message: string; detail: string; confirmLabel: string },
): Promise<boolean> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const box = {
    type: 'warning' as const,
    buttons: ['Cancel', opts.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: opts.message,
    detail: opts.detail,
  }
  const res = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box)
  return res.response === 1
}

export function registerIpc(ctx: IpcContext): void {
  const handlers: { [C in IpcChannel]: Handler<C> } = {
    'repo:open': ({ path }) => openAndRegister(path, ctx),
    'repo:pick': async (_input, event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = { title: 'Open Repository', properties: ['openDirectory' as const] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const picked = res.filePaths[0]
      if (res.canceled || !picked) return null
      return openAndRegister(picked, ctx)
    },
    'repo:recent': () => ctx.recent.list(),
    'repo:clone': async ({ url }, event) => {
      // Where to clone is chosen in a native dialog, never sent by the renderer.
      const parent = await pickFolder(event, 'Choose where to clone the repository', 'Clone here')
      if (!parent) return null
      const { path } = await ctx.network.run(event.sender, (net) => cloneRepository(url, parent, net), parent)
      return openAndRegister(path, ctx)
    },
    'repo:init': async (_input, event) => {
      const dir = await pickFolder(event, 'Choose a folder for the new repository', 'Create repository')
      if (!dir) return null
      await initRepository(dir, { initialBranch: 'main' })
      return openAndRegister(dir, ctx)
    },
    'repo:activate': async ({ repoPath }) => {
      // Switching tabs: watch the now-visible repository.
      const info = openedRepos.get(requireOpened(repoPath))!
      ctx.onRepositoryOpened?.(info)
    },
    'repo:refs': ({ repoPath }) => listRefs(requireOpened(repoPath)),
    'repo:head': ({ repoPath }) => getHead(requireOpened(repoPath)),
    'log:page': ({ repoPath, skip, limit, filter }) =>
      getCommitPage(requireOpened(repoPath), { skip, limit, ...(filter ? { filter } : {}) }),
    'log:search': ({ repoPath, query }) => searchCommits(requireOpened(repoPath), query),
    'commit:details': ({ repoPath, sha }) => getCommitDetails(requireOpened(repoPath), sha),
    'status:get': ({ repoPath }) => getStatus(requireOpened(repoPath)),
    'index:stage': ({ repoPath, paths }) => stagePaths(requireOpened(repoPath), paths),
    'index:unstage': ({ repoPath, paths }) => unstagePaths(requireOpened(repoPath), paths),
    'index:stage-all': ({ repoPath }) => stageAll(requireOpened(repoPath)),
    'index:unstage-all': ({ repoPath }) => unstageAll(requireOpened(repoPath)),
    'worktree:discard': async ({ repoPath, paths }, event) => {
      requireOpened(repoPath)
      // Confirmation is shown by main, not the renderer, so it cannot be bypassed.
      const confirmed = await confirmDestructive(event, {
        message: paths.length === 1 ? `Discard changes to ${paths[0]}?` : `Discard changes to ${paths.length} files?`,
        detail:
          'Unstaged modifications will be lost. Untracked files are moved to the system trash. Staged changes are kept.',
        confirmLabel: 'Discard changes',
      })
      if (!confirmed) return { discarded: false }
      await discardPaths(repoPath, paths, { trash: (abs) => shell.trashItem(abs) })
      return { discarded: true }
    },
    'diff:file': ({ repoPath, target }) => getFileDiff(requireOpened(repoPath), target),
    'diff:contents': ({ repoPath, target }) => getFileContents(requireOpened(repoPath), target),
    'diff:apply-hunks': async ({ repoPath, path, source, action, selections }, event) => {
      requireOpened(repoPath)
      if (action === 'discard') {
        const lines = selections.some((s) => s.lines)
        const confirmed = await confirmDestructive(event, {
          message: lines ? `Discard the selected lines in ${path}?` : `Discard ${selections.length === 1 ? 'this change' : `${selections.length} changes`} in ${path}?`,
          detail: 'These unstaged edits will be lost. Other changes in the file are kept.',
          confirmLabel: 'Discard',
        })
        if (!confirmed) return { applied: false }
      }
      await applyHunks(repoPath, path, source, action, selections)
      return { applied: true }
    },
    'conflict:get': ({ repoPath, path }) => getConflictVersions(requireOpened(repoPath), path),
    'conflict:describe': ({ repoPath, path }) => describeConflict(requireOpened(repoPath), path),
    'conflict:resolve-with': async ({ repoPath, path, choice }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message:
          choice === 'delete'
            ? `Resolve the conflict by deleting ${path}?`
            : `Resolve the conflict by keeping the ${choice === 'ours' ? 'current branch' : 'incoming'} version of ${path}?`,
        detail: 'The file in your working folder is replaced with that version and marked resolved.',
        confirmLabel: choice === 'delete' ? 'Delete file' : 'Use this version',
      })
      if (!confirmed) return { resolved: false }
      await resolveConflictWith(repoPath, path, choice)
      return { resolved: true }
    },
    'lfs:status': ({ repoPath }) => getLfsStatus(requireOpened(repoPath)),
    'lfs:install': ({ repoPath }) => installLfs(requireOpened(repoPath)),
    'lfs:track': async ({ repoPath, pattern }) => ({ changed: (await trackPattern(requireOpened(repoPath), pattern)).changed }),
    'lfs:untrack': async ({ repoPath, pattern }) => ({ changed: (await untrackPattern(requireOpened(repoPath), pattern)).changed }),
    'lfs:pull': ({ repoPath }, event) =>
      ctx.network.run(event.sender, (net) => pullLfs(requireOpened(repoPath), { ...(net.env ? { env: net.env } : {}), ...(net.signal ? { signal: net.signal } : {}) }), repoPath),
    'conflict:save': ({ repoPath, path, content, markResolved }) =>
      saveConflictResolution(requireOpened(repoPath), path, content, { markResolved }),
    'commit:create': ({ repoPath, message, amend }) => createCommit(requireOpened(repoPath), message, { amend }),
    'commit:last-message': ({ repoPath }) => getLastCommitMessage(requireOpened(repoPath)),
    'branch:create': ({ repoPath, name, startPoint, checkout }) =>
      createBranch(requireOpened(repoPath), name, { startPoint, checkout }),
    'branch:checkout': ({ repoPath, ref }) => checkoutRef(requireOpened(repoPath), ref),
    'commit:checkout': ({ repoPath, sha }) => checkoutDetached(requireOpened(repoPath), sha),
    'branch:rename': ({ repoPath, oldName, newName }) => renameBranch(requireOpened(repoPath), oldName, newName),
    'branch:delete': async ({ repoPath, name, force }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: force ? `Force delete unmerged branch "${name}"?` : `Delete branch "${name}"?`,
        detail: force
          ? 'This branch has commits that are not merged anywhere else. They will only be recoverable through the reflog.'
          : 'The local branch will be deleted. Its commits remain reachable from other branches.',
        confirmLabel: force ? 'Force delete' : 'Delete branch',
      })
      if (!confirmed) return { deleted: false }
      await deleteBranch(repoPath, name, { force })
      return { deleted: true }
    },
    'branch:set-upstream': ({ repoPath, name, upstream }) => setUpstream(requireOpened(repoPath), name, upstream),
    'remote:list': ({ repoPath }) => listRemotes(requireOpened(repoPath)),
    'remote:add': ({ repoPath, name, url }) => addRemote(requireOpened(repoPath), name, url),
    'remote:remove': async ({ repoPath, name }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: `Remove remote "${name}"?`,
        detail: 'Its remote-tracking branches will be deleted locally. Nothing is deleted on the server.',
        confirmLabel: 'Remove remote',
      })
      if (!confirmed) return { removed: false }
      await removeRemote(repoPath, name)
      return { removed: true }
    },
    'remote:fetch': ({ repoPath, remote, prune }, event) =>
      ctx.network.run(
        event.sender,
        (net: NetworkOptions) => fetch(requireOpened(repoPath), { ...net, prune, ...(remote ? { remote } : {}) }),
        repoPath,
      ),
    'remote:pull': ({ repoPath, mode }, event) =>
      ctx.network.run(event.sender, (net) => pull(requireOpened(repoPath), { ...net, mode }), repoPath),
    'remote:push': async ({ repoPath, branch, remote, setUpstream: track, force }, event) => {
      requireOpened(repoPath)
      if (force !== 'none') {
        const confirmed = await confirmDestructive(event, {
          message: `Force push "${branch}" to ${remote}?`,
          detail:
            'Commits on the remote branch that you do not have locally will be overwritten. --force-with-lease refuses if the remote moved since your last fetch.',
          confirmLabel: 'Force push',
        })
        if (!confirmed) return { pushed: false }
      }
      await ctx.network.run(event.sender, (net) => push(repoPath, { ...net, branch, remote, setUpstream: track, force }), repoPath)
      return { pushed: true }
    },
    'stash:list': ({ repoPath }) => listStashes(requireOpened(repoPath)),
    'stash:create': ({ repoPath, message, includeUntracked }) =>
      createStash(requireOpened(repoPath), { includeUntracked, ...(message?.trim() ? { message: message.trim() } : {}) }),
    'stash:apply': ({ repoPath, index, sha, pop }) =>
      applyStash(requireOpened(repoPath), index, { pop, restoreIndex: true, expectedSha: sha }),
    'stash:drop': async ({ repoPath, index, sha }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: `Delete stash@{${index}}?`,
        detail: 'The stashed changes will be removed. They can only be recovered with low-level Git tools.',
        confirmLabel: 'Delete stash',
      })
      if (!confirmed) return { dropped: false }
      await dropStash(repoPath, index, { expectedSha: sha })
      return { dropped: true }
    },
    'stash:files': ({ repoPath, index, sha }) => getStashFiles(requireOpened(repoPath), index, { expectedSha: sha }),
    'tag:list': ({ repoPath }) => listTags(requireOpened(repoPath)),
    'tag:create': ({ repoPath, name, target, message }) =>
      createTag(requireOpened(repoPath), name, target, message ? { message } : {}),
    'tag:delete': async ({ repoPath, name }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: `Delete tag "${name}"?`,
        detail: 'The local tag is deleted. Copies already pushed to a remote are not affected.',
        confirmLabel: 'Delete tag',
      })
      if (!confirmed) return { deleted: false }
      await deleteTag(repoPath, name)
      return { deleted: true }
    },
    'tag:push': ({ repoPath, name, remote }, event) =>
      ctx.network.run(event.sender, (net) => pushTag(requireOpened(repoPath), remote, name, net), repoPath),
    'history:reset': async ({ repoPath, target, mode }, event) => {
      requireOpened(repoPath)
      if (mode === 'hard') {
        const confirmed = await confirmDestructive(event, {
          message: `Hard reset to ${target.slice(0, 7)}?`,
          detail:
            'The current branch and all files are reset to this commit. GitBob first saves your uncommitted changes as a backup stash ("GitBob: backup before hard reset"), so you can restore them from the Stashes list.',
          confirmLabel: 'Hard reset',
        })
        if (!confirmed) return { done: false, backupStash: null }
      }
      return { done: true, ...(await reset(repoPath, target, mode)) }
    },
    'history:revert': ({ repoPath, sha }) => revert(requireOpened(repoPath), sha),
    'history:cherry-pick': ({ repoPath, shas }) => cherryPick(requireOpened(repoPath), shas),
    'op:continue': async ({ repoPath }) => {
      const res = await continueOperation(requireOpened(repoPath))
      // Remove reword/squash message files left by an interactive rebase once it has finished.
      await cleanupRebaseFiles(repoPath).catch(() => {})
      return res
    },
    'op:abort': async ({ repoPath }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: 'Abort the operation in progress?',
        detail: 'The repository returns to the state before the operation started. Conflict resolutions you made are lost.',
        confirmLabel: 'Abort',
      })
      if (!confirmed) return { operation: null }
      const res = await abortOperation(repoPath)
      await cleanupRebaseFiles(repoPath).catch(() => {})
      return res
    },
    'op:skip': ({ repoPath }) => skipOperation(requireOpened(repoPath)),
    'reflog:get': ({ repoPath, limit }) => getReflog(requireOpened(repoPath), 'HEAD', limit),
    'rebase:todo': ({ repoPath, base }) => getRebaseTodo(requireOpened(repoPath), base),
    'rebase:start': ({ repoPath, base, todo }) => interactiveRebase(requireOpened(repoPath), base, todo),
    'blame:get': ({ repoPath, path, rev }) => getBlame(requireOpened(repoPath), path, rev),
    'worktree:list': ({ repoPath }) => listWorktrees(requireOpened(repoPath)),
    'worktree:add': async ({ repoPath, newBranch, branch }, event) => {
      requireOpened(repoPath)
      // The folder is chosen in a native dialog, never sent by the renderer.
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: 'Choose an empty folder for the new worktree',
        buttonLabel: 'Create worktree here',
        properties: ['openDirectory' as const, 'createDirectory' as const],
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const path = res.filePaths[0]
      if (res.canceled || !path) return null
      await addWorktree(repoPath, path, { ...(newBranch ? { newBranch } : {}), ...(branch ? { branch } : {}) })
      return { path }
    },
    'worktree:remove': async ({ repoPath, path, force }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: force ? `Force remove the worktree at ${path}?` : `Remove the worktree at ${path}?`,
        detail: force
          ? 'The folder and any uncommitted changes in it will be deleted.'
          : 'The worktree folder is deleted. Git refuses if it has uncommitted changes.',
        confirmLabel: force ? 'Force remove' : 'Remove worktree',
      })
      if (!confirmed) return { removed: false }
      await removeWorktree(repoPath, path, { force })
      return { removed: true }
    },
    'submodule:list': ({ repoPath }) => listSubmodules(requireOpened(repoPath)),
    'submodule:update': ({ repoPath, paths }, event) =>
      ctx.network.run(event.sender, (net) =>
        updateSubmodules(requireOpened(repoPath), {
          init: true,
          recursive: true,
          ...(paths ? { paths } : {}),
          ...(net.env ? { env: net.env } : {}),
          ...(net.signal ? { signal: net.signal } : {}),
        }),
        repoPath,
      ),
    'commit:signature': ({ repoPath, sha }) => getSignature(requireOpened(repoPath), sha),
    'settings:get': async () => ctx.getSettings(),
    'settings:update': ({ patch }) => ctx.updateSettings(patch),
    'app:info': () => appInfo(),
    'app:git-identity': () => gitIdentity(),
    'app:set-git-identity': ({ name, email }) => setGitIdentity(name, email),
    'app:check-update': () => ctx.updater.check(),
    'app:download-update': () => ctx.updater.download(),
    'app:install-update': () => ctx.updater.install(),
    'app:pick-git': async (_input, event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: 'Choose the Git program',
        buttonLabel: 'Use this Git',
        properties: ['openFile' as const, 'showHiddenFiles' as const],
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const path = res.filePaths[0]
      if (res.canceled || !path) return null
      const version = await validateGitPath(path)
      await ctx.updateSettings({ gitPath: path })
      return { path, version }
    },
    'provider:status': ({ repoPath }) => ctx.providers.status(requireOpened(repoPath)),
    'provider:connect': ({ repoPath, token }) => ctx.providers.connect(requireOpened(repoPath), token),
    'provider:disconnect': async ({ repoPath }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: 'Disconnect this account?',
        detail: 'The stored access token is deleted from this computer. You can connect again with a new token.',
        confirmLabel: 'Disconnect',
      })
      if (!confirmed) return { disconnected: false }
      await ctx.providers.disconnect(repoPath)
      return { disconnected: true }
    },
    'provider:pulls': ({ repoPath, state }) => ctx.providers.pullRequests(requireOpened(repoPath), state),
    'provider:checks': ({ repoPath, sha }) => ctx.providers.checks(requireOpened(repoPath), sha),
    'provider:accounts': () => ctx.providers.accounts(),
    'provider:hosted-repos': ({ kind, host }) => ctx.providers.hostedRepositories(kind, host),
    'provider:create-pr': ({ repoPath, ...input }) => ctx.providers.createPullRequest(requireOpened(repoPath), input),
    'provider:pr': ({ repoPath, number }) => ctx.providers.pullRequest(requireOpened(repoPath), number),
    'provider:pr-comments': ({ repoPath, number }) => ctx.providers.comments(requireOpened(repoPath), number),
    'provider:pr-comment': ({ repoPath, number, body }) => ctx.providers.addComment(requireOpened(repoPath), number, body),
    'provider:pr-review': ({ repoPath, number, event, body }) => ctx.providers.review(requireOpened(repoPath), number, event, body),
    'provider:pr-merge': async ({ repoPath, number, method, expectedHeadSha, deleteSourceBranch }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: `Merge pull request #${number} (${method === 'merge' ? 'merge commit' : method})?`,
        detail: `This merges on the hosting service for everyone${deleteSourceBranch ? ' and deletes the source branch' : ''}. GitBob refuses if the pull request changed since you loaded it.`,
        confirmLabel: 'Merge',
      })
      if (!confirmed) return { done: false, merged: false, message: '' }
      const res = await ctx.providers.merge(repoPath, number, { method, deleteSourceBranch, ...(expectedHeadSha ? { expectedHeadSha } : {}) })
      return { done: true, merged: res.merged, message: res.message }
    },
    'provider:pr-changes': ({ repoPath, number }, event) =>
      ctx.network.run(event.sender, (net) => ctx.providers.changes(requireOpened(repoPath), number, net), repoPath),
    'provider:signin-start': ({ repoPath }) => ctx.providers.startGitHubSignIn(requireOpened(repoPath)),
    'provider:signin-finish': ({ repoPath }) => ctx.providers.finishGitHubSignIn(requireOpened(repoPath)),
    'provider:signin-cancel': async () => ctx.providers.cancelGitHubSignIn(),
    'credentials:respond': async ({ id, answer, remember }) => ctx.network.respond(id, answer, remember),
    'op:cancel': async () => ctx.network.cancel(),
  }

  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, raw: unknown): Promise<Result<unknown>> => {
      if (!ctx.isTrustedSender(event)) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Untrusted IPC sender' } }
      }
      const parsed = ipcInputSchemas[channel].safeParse(raw ?? {})
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: 'INVALID_ARGUMENT', message: `Invalid input for ${channel}`, detail: parsed.error.message },
        }
      }
      try {
        const handler = handlers[channel] as Handler<IpcChannel>
        const data = await handler(parsed.data as never, event)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: toAppError(err) }
      }
    })
  }
}

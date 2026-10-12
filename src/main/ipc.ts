import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, type IpcChannel } from '@shared/channels'
import { ipcInputSchemas } from '@shared/ipc'
import type { IpcOutputs } from '@shared/ipc-types'
import type { Result } from '@shared/result'
import type { AppSettings, RepositoryInfo } from '@shared/types'
import { GitError, toAppError } from '@git-core/errors'
import { openRepository } from '@git-core/repository'
import { getHead, listRefs } from '@git-core/refs'
import { getCommitPage, countCommits } from '@git-core/log'
import { cloneRepository, initRepository } from '@git-core/create'
import { getCommitDetails, listCommitFiles } from '@git-core/details'
import { searchCommits } from '@git-core/search'
import { getStatus } from '@git-core/status'
import { discardPaths, stageAll, stagePaths, unstageAll, unstagePaths } from '@git-core/staging'
import { getFileDiff } from '@git-core/diff'
import { getFileContents } from '@git-core/contents'
import { applyHunks } from '@git-core/patch'
import { describeConflict, getConflictVersions, resolveConflictWith, saveConflictResolution } from '@git-core/conflicts'
import { getLfsStatus, installLfs, pullLfs, trackPattern, untrackPattern } from '@git-core/lfs'
import { createCommit, getCommitTemplate, getLastCommitMessage } from '@git-core/commit'
import {
  checkoutDetached,
  checkoutRef,
  createBranch,
  deleteBranch,
  renameBranch,
  setUpstream,
  fastForwardBranch,
} from '@git-core/branches'
import { addRemote, deleteRemoteBranch, fetch, listRemotes, pull, push, removeRemote, type NetworkOptions } from '@git-core/remotes'
import type { NetworkSession } from './network'
import type { ProviderService } from './providers'
import { appInfo, gitIdentity, setGitIdentity, validateGitPath } from './app-info'
import type { Updater } from './updater'
import { applyStash, applyStashFile, createStash, dropStash, getStashFiles, listStashes, stashToBranch } from '@git-core/stash'
import { createTag, deleteTag, listTags, pushTag } from '@git-core/tags'
import { abortOperation, cherryPick, commitsToRebase, continueOperation, mergeRef, rebaseOnto, reset, revert, rewordHead, skipOperation } from '@git-core/history'
import { getReflog } from '@git-core/reflog'
import { cleanupRebaseFiles, getRebaseTodo, interactiveRebase } from '@git-core/rebase'
import { getBlame } from '@git-core/blame'
import { addWorktree, listWorktrees, removeWorktree } from '@git-core/worktrees'
import { listSubmodules, updateSubmodules } from '@git-core/submodules'
import { getSignature } from '@git-core/signatures'
import type { RecentRepositoryStore } from './recent'
import type { UndoJournal } from './undo'
import type { AvatarService } from './avatars'
import type { ProfileStore } from './profiles'
import { parseRemoteUrl } from '../providers'
import { RepoHealth } from './repo-health'
import { openTerminal } from './terminal'
import { writeCommitGraph } from '@git-core/maintenance'
import { getFileHistory } from '@git-core/file-history'
import { getWorktreeCompareFiles, saveCommitPatch } from '@git-core/compare'
import { combineCommits } from '@git-core/combine'
import { readFileForEdit, saveEditedFile } from '@git-core/worktree-file'
import { getOperation } from '@git-core/status'
import { resolveRepoPath } from '@git-core/paths'
import { headSnapshot, readRef, type HeadSnapshot, type UndoStep } from '@git-core/undo'
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
  undo: UndoJournal
  avatars: AvatarService
  profiles: ProfileStore
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

const short = (sha: string | null): string => (sha ?? '').slice(0, 7)
const subject = (message: string): string => {
  const line = message.trim().split('\n')[0] ?? ''
  return line.length > 50 ? `${line.slice(0, 49)}…` : line
}
const at = (head: HeadSnapshot, sha: string | null): HeadSnapshot => ({ sha, ref: head.ref })

/** Undo/redo steps for an operation that moved the current branch from `before` to `after`. */
function branchMove(before: HeadSnapshot, after: HeadSnapshot, mode: 'soft' | 'mixed' | 'keep'): { undo: UndoStep[]; redo: UndoStep[] } | null {
  if (!before.sha || !after.sha || before.sha === after.sha || before.ref !== after.ref) return null
  return {
    undo: [{ type: 'reset', mode, expect: after, to: before.sha }],
    redo: [{ type: 'reset', mode, expect: at(after, before.sha), to: after.sha }],
  }
}

function checkoutSteps(before: HeadSnapshot, after: HeadSnapshot): { undo: UndoStep[]; redo: UndoStep[] } | null {
  if (!before.sha || !after.sha || (before.sha === after.sha && before.ref === after.ref)) return null
  return { undo: [{ type: 'checkout', expect: after, to: before }], redo: [{ type: 'checkout', expect: before, to: after }] }
}

export function registerIpc(ctx: IpcContext): void {
  const health = new RepoHealth()
  /**
   * Run a mutation of an opened repository and, if it completed (no conflict stop), record how
   * to undo and redo it. Recording problems never fail the operation itself.
   */
  async function journaled<T>(
    repoPath: string,
    label: string | ((result: T) => string),
    fn: () => Promise<T>,
    build: (before: HeadSnapshot, after: HeadSnapshot, result: T) => Promise<{ undo: UndoStep[]; redo: UndoStep[] } | null> | { undo: UndoStep[]; redo: UndoStep[] } | null,
  ): Promise<T> {
    const before = await headSnapshot(repoPath)
    const result = await fn()
    try {
      if (!(await getOperation(repoPath))) {
        const steps = await build(before, await headSnapshot(repoPath), result)
        if (steps) ctx.undo.record(repoPath, { label: typeof label === 'string' ? label : label(result), ...steps })
      }
    } catch {
      /* not undoable; the operation itself succeeded */
    }
    return result
  }

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
    'log:page': ({ repoPath, skip, limit, filter, hidden }) =>
      health.timeFirstPage(requireOpened(repoPath), filter ? -1 : skip, () =>
        getCommitPage(repoPath, { skip, limit, ...(filter ? { filter } : {}), ...(hidden?.length ? { hidden } : {}) }),
      ),
    'log:count': ({ repoPath, hidden }) => countCommits(requireOpened(repoPath), hidden ?? []),
    'log:search': ({ repoPath, query }) => searchCommits(requireOpened(repoPath), query),
    'commit:details': ({ repoPath, sha }) => getCommitDetails(requireOpened(repoPath), sha),
    'commit:all-files': ({ repoPath, sha }) => listCommitFiles(requireOpened(repoPath), sha),
    'status:get': ({ repoPath }) => health.timeStatus(requireOpened(repoPath), () => getStatus(repoPath)),
    'branch:merge': ({ repoPath, ref, mode }) =>
      journaled(
        requireOpened(repoPath),
        `Merge ${ref.replace(/^refs\/(heads|remotes|tags)\//, '')}`,
        () => mergeRef(repoPath, ref, { mode }),
        (b, a) => branchMove(b, a, 'keep'),
      ),
    'branch:rebase': async ({ repoPath, onto }, event) => {
      requireOpened(repoPath)
      const name = onto.replace(/^refs\/(heads|remotes|tags)\//, '')
      const count = await commitsToRebase(repoPath, onto)
      const head = await headSnapshot(repoPath)
      const current = (head.ref ?? '').replace(/^refs\/heads\//, '') || 'the current branch'
      if (count > 0) {
        const confirmed = await confirmDestructive(event, {
          message: `Rebase ${current} onto ${name}?`,
          detail: `${count} commit${count === 1 ? '' : 's'} of ${current} will be rewritten on top of ${name}. If ${current} was already pushed, you will need to force push it afterwards. Undo can take the rebase back.`,
          confirmLabel: 'Rebase',
        })
        if (!confirmed) return { done: false }
      }
      await journaled(repoPath, `Rebase onto ${name}`, () => rebaseOnto(repoPath, onto), (b, a) => branchMove(b, a, 'keep'))
      return { done: true }
    },
    'file:history': ({ repoPath, path, skip }) => getFileHistory(requireOpened(repoPath), path, { skip, limit: 500 }),
    'repo:open-terminal': ({ repoPath }) => openTerminal(requireOpened(repoPath)),
    'repo:reveal': async ({ repoPath }) => {
      const err = await shell.openPath(requireOpened(repoPath))
      if (err) throw new GitError('GIT_FAILED', err)
    },
    'profile:list': async () => ctx.profiles.read(),
    'profile:create': async ({ name }) => ctx.profiles.create(name),
    'profile:rename': async ({ id, name }) => ctx.profiles.rename(id, name),
    'profile:remove': async ({ id }, event) => {
      const p = ctx.profiles.read().profiles.find((x) => x.id === id)
      if (!p) throw new GitError('NOT_FOUND', 'Unknown profile')
      const confirmed = await confirmDestructive(event, {
        message: `Remove the profile “${p.name}”?`,
        detail: 'It disappears from the list. Its settings, accounts and recent repositories stay on disk in its folder, so nothing is deleted.',
        confirmLabel: 'Remove profile',
      })
      if (!confirmed) return { removed: false }
      ctx.profiles.remove(id)
      return { removed: true }
    },
    'profile:switch': async ({ id }) => {
      ctx.profiles.setActive(id)
      // Restart into the profile: its data folder is chosen before the app starts.
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 50)
    },
    'commit:reword-head': ({ repoPath, message }) =>
      journaled(requireOpened(repoPath), 'Edit commit message', () => rewordHead(repoPath, message), (b, a) => branchMove(b, a, 'soft')),
    'branch:delete-remote': async ({ repoPath, remote, branch }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: `Delete ${remote}/${branch} on the server?`,
        detail: `The branch is deleted from ${remote} for everyone. Commits that only it contains can be lost there. Your local branches are not touched.`,
        confirmLabel: 'Delete remote branch',
      })
      if (!confirmed) return { deleted: false }
      await ctx.network.run(event.sender, (net) => deleteRemoteBranch(repoPath, { ...net, remote, branch }), repoPath)
      return { deleted: true }
    },
    'branch:fast-forward': ({ repoPath, branch, to }) =>
      journaled(requireOpened(repoPath), `Fast-forward ${branch}`, () => fastForwardBranch(repoPath, branch, to), () => null),
    'branch:pull-other': async ({ repoPath, branch }, event) => {
      requireOpened(repoPath)
      const local = (await listRefs(repoPath)).find((r) => r.name === `refs/heads/${branch}`)
      if (!local?.upstream) throw new GitError('INVALID_ARGUMENT', `${branch} has no upstream branch`)
      const m = /^refs\/remotes\/([^/]+)\//.exec(local.upstream)
      if (!m) throw new GitError('INVALID_ARGUMENT', `${branch} tracks a local branch`)
      await ctx.network.run(event.sender, (net) => fetch(repoPath, { ...net, prune: false, remote: m[1]! }), repoPath)
      return fastForwardBranch(repoPath, branch, local.upstream)
    },
    'compare:files': ({ repoPath, sha }) => getWorktreeCompareFiles(requireOpened(repoPath), sha),
    'commits:combine': ({ repoPath, shas, wholeRange }) => combineCommits(requireOpened(repoPath), shas, { wholeRange: !!wholeRange }),
    'commit:save-patch': async ({ repoPath, sha }, event) => {
      requireOpened(repoPath)
      const subject = (await getCommitDetails(repoPath, sha)).subject
      const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'commit'
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = { title: 'Save patch', defaultPath: `${sha.slice(0, 7)}-${slug}.patch`, filters: [{ name: 'Patch', extensions: ['patch'] }] }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      await saveCommitPatch(repoPath, sha, res.filePath)
      return { path: res.filePath }
    },
    'app:copy': async ({ text }) => clipboard.writeText(text),
    'app:confirm': ({ message, detail, confirmLabel }, event) => confirmDestructive(event, { message, detail: detail ?? '', confirmLabel }),
    'repo:health': async ({ repoPath }) => ({ suggestCommitGraph: await health.suggestCommitGraph(requireOpened(repoPath)) }),
    'repo:write-commit-graph': async ({ repoPath }) => {
      await writeCommitGraph(requireOpened(repoPath))
      health.commitGraphWritten(repoPath)
    },
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
    'commit:create': ({ repoPath, message, amend, paths }) =>
      journaled(
        requireOpened(repoPath),
        `${amend ? 'Amend' : 'Commit'} "${subject(message)}"`,
        () => createCommit(repoPath, message, { amend, ...(paths?.length ? { paths } : {}) }),
        (before, after) => branchMove(before, after, 'soft'),
      ),
    'commit:last-message': ({ repoPath }) => getLastCommitMessage(requireOpened(repoPath)),
    'file:read': ({ repoPath, path }) => readFileForEdit(requireOpened(repoPath), path),
    'file:write': ({ repoPath, path, content, baseHash }) => saveEditedFile(requireOpened(repoPath), path, content, baseHash),
    'commit:template': ({ repoPath }) => getCommitTemplate(requireOpened(repoPath)),
    'branch:create': ({ repoPath, name, startPoint, checkout }) =>
      journaled(
        requireOpened(repoPath),
        `Create branch "${name}"`,
        () => createBranch(repoPath, name, { startPoint, checkout }),
        async (before, after) => {
          const ref = `refs/heads/${name}`
          const sha = await readRef(repoPath, ref)
          if (!sha) return null
          if (!checkout) return { undo: [{ type: 'ref', ref, from: sha, to: null }], redo: [{ type: 'ref', ref, from: null, to: sha }] }
          if (!before.sha) return null
          return {
            undo: [{ type: 'checkout', expect: after, to: before }, { type: 'ref', ref, from: sha, to: null }],
            redo: [{ type: 'ref', ref, from: null, to: sha }, { type: 'checkout', expect: before, to: after }],
          }
        },
      ),
    'branch:checkout': ({ repoPath, ref }) =>
      journaled(requireOpened(repoPath), (r) => `Check out ${r.branch}`, () => checkoutRef(repoPath, ref), checkoutSteps),
    'commit:checkout': ({ repoPath, sha }) =>
      journaled(requireOpened(repoPath), `Check out ${short(sha)}`, () => checkoutDetached(repoPath, sha), checkoutSteps),
    'branch:rename': ({ repoPath, oldName, newName }) =>
      journaled(
        requireOpened(repoPath),
        `Rename branch "${oldName}" to "${newName}"`,
        () => renameBranch(repoPath, oldName, newName),
        () => ({ undo: [{ type: 'rename-branch', from: newName, to: oldName }], redo: [{ type: 'rename-branch', from: oldName, to: newName }] }),
      ),
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
      const ref = `refs/heads/${name}`
      const sha = await readRef(repoPath, ref)
      await journaled(repoPath, `Delete branch "${name}"`, () => deleteBranch(repoPath, name, { force }), () =>
        sha ? { undo: [{ type: 'ref', ref, from: null, to: sha }], redo: [{ type: 'ref', ref, from: sha, to: null }] } : null,
      )
      return { deleted: true }
    },
    'branch:set-upstream': ({ repoPath, name, upstream }) => setUpstream(requireOpened(repoPath), name, upstream),
    'remote:list': async ({ repoPath }) =>
      (await listRemotes(requireOpened(repoPath))).map((r) => {
        const ref = parseRemoteUrl(r.fetchUrl) ?? parseRemoteUrl(r.pushUrl)
        return ref ? { ...r, hosted: { kind: ref.kind, owner: ref.owner.split('/')[0]!, webUrl: ref.webUrl } } : r
      }),
    'avatar:get': (req) => {
      const mode = ctx.getSettings().avatars
      if (mode === 'off' || (req.kind === 'email' && req.source === 'gravatar' && mode !== 'gravatar')) return Promise.resolve(null)
      return ctx.avatars.get(req)
    },
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
      journaled(
        requireOpened(repoPath),
        'Pull',
        () => ctx.network.run(event.sender, (net) => pull(repoPath, { ...net, mode }), repoPath),
        (before, after) => branchMove(before, after, 'keep'),
      ),
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
    'stash:create': ({ repoPath, message, includeUntracked, paths }) =>
      createStash(requireOpened(repoPath), { includeUntracked, ...(message?.trim() ? { message: message.trim() } : {}), ...(paths?.length ? { paths } : {}) }),
    'stash:branch': ({ repoPath, index, sha, name }) => stashToBranch(requireOpened(repoPath), index, name, { expectedSha: sha }),
    'stash:apply-file': ({ repoPath, index, sha, path }) => applyStashFile(requireOpened(repoPath), index, path, { expectedSha: sha }),
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
      journaled(
        requireOpened(repoPath),
        `Create tag "${name}"`,
        () => createTag(repoPath, name, target, message ? { message } : {}),
        async () => {
          const ref = `refs/tags/${name}`
          const oid = await readRef(repoPath, ref)
          return oid ? { undo: [{ type: 'ref', ref, from: oid, to: null }], redo: [{ type: 'ref', ref, from: null, to: oid }] } : null
        },
      ),
    'tag:delete': async ({ repoPath, name }, event) => {
      requireOpened(repoPath)
      const confirmed = await confirmDestructive(event, {
        message: `Delete tag "${name}"?`,
        detail: 'The local tag is deleted. Copies already pushed to a remote are not affected.',
        confirmLabel: 'Delete tag',
      })
      if (!confirmed) return { deleted: false }
      const ref = `refs/tags/${name}`
      const oid = await readRef(repoPath, ref)
      await journaled(repoPath, `Delete tag "${name}"`, () => deleteTag(repoPath, name), () =>
        oid ? { undo: [{ type: 'ref', ref, from: null, to: oid }], redo: [{ type: 'ref', ref, from: oid, to: null }] } : null,
      )
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
      const result = await journaled(
        repoPath,
        `Reset (${mode}) to ${short(target)}`,
        () => reset(repoPath, target, mode),
        (before, after, r) => {
          if (mode !== 'hard') return branchMove(before, after, mode)
          if (!before.sha || !after.sha || before.ref !== after.ref) return null
          return {
            undo: [{ type: 'restore-hard-reset', expect: after, to: before.sha, backupStash: r.backupStash }],
            redo: [{ type: 'hard-reset', expect: at(after, before.sha), to: after.sha }],
          }
        },
      )
      return { done: true, ...result }
    },
    'history:revert': ({ repoPath, sha }) =>
      journaled(requireOpened(repoPath), `Revert ${short(sha)}`, () => revert(repoPath, sha), (b, a) => branchMove(b, a, 'keep')),
    'history:cherry-pick': ({ repoPath, shas }) =>
      journaled(
        requireOpened(repoPath),
        shas.length === 1 ? `Cherry-pick ${short(shas[0]!)}` : `Cherry-pick ${shas.length} commits`,
        () => cherryPick(repoPath, shas),
        (b, a) => branchMove(b, a, 'keep'),
      ),
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
    'rebase:start': ({ repoPath, base, todo }) =>
      journaled(requireOpened(repoPath), 'Interactive rebase', () => interactiveRebase(repoPath, base, todo), (b, a) => branchMove(b, a, 'keep')),
    'undo:state': async ({ repoPath }) => ctx.undo.state(requireOpened(repoPath)),
    'undo:undo': ({ repoPath }) => ctx.undo.undo(requireOpened(repoPath)),
    'undo:redo': ({ repoPath }) => ctx.undo.redo(requireOpened(repoPath)),
    'blame:get': ({ repoPath, path, rev }) => getBlame(requireOpened(repoPath), path, rev),
    'worktree:list': ({ repoPath }) => listWorktrees(requireOpened(repoPath)),
    'worktree:add': async ({ repoPath, newBranch, branch, startPoint }, event) => {
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
      await addWorktree(
        repoPath,
        path,
        branch ? { branch } : newBranch ? { newBranch, ...(startPoint ? { startPoint } : {}) } : { detach: true, ...(startPoint ? { startPoint } : {}) },
      )
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
    'provider:issues': ({ repoPath }) => ctx.providers.issues(requireOpened(repoPath)),
    'provider:pulls': ({ repoPath, state }) => ctx.providers.pullRequests(requireOpened(repoPath), state),
    'provider:checks': ({ repoPath, sha }) => ctx.providers.checks(requireOpened(repoPath), sha),
    'provider:accounts': () => ctx.providers.accounts(),
    'provider:hosted-repos': ({ kind, host }) => ctx.providers.hostedRepositories(kind, host),
    'provider:create-pr': ({ repoPath, ...input }) => ctx.providers.createPullRequest(requireOpened(repoPath), input),
    'provider:pr': ({ repoPath, number }) => ctx.providers.pullRequest(requireOpened(repoPath), number),
    'provider:pr-comments': ({ repoPath, number }) => ctx.providers.comments(requireOpened(repoPath), number),
    'provider:pr-comment': ({ repoPath, number, body }) => ctx.providers.addComment(requireOpened(repoPath), number, body),
    'provider:pr-line-comment': ({ repoPath, number, ...input }) => {
      requireOpened(repoPath)
      // Paths must name a file inside the repository (also validated by the adapter).
      resolveRepoPath(repoPath, input.path)
      if (input.oldPath) resolveRepoPath(repoPath, input.oldPath)
      return ctx.providers.addLineComment(repoPath, number, input)
    },
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

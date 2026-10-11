import { z } from 'zod'
import type { IpcChannel } from './channels'

/**
 * IPC contract. Every renderer -> main call is declared here with a zod schema
 * for its input. The main process validates all input before acting on it.
 * Response types are declared statically (main is trusted).
 */

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'path must not contain NUL')

/** A full or abbreviated hex object id. Rejects anything that could be parsed as an option or revision expression. */
export const shaSchema = z.string().regex(/^[0-9a-f]{4,64}$/i, 'expected a hexadecimal object id')

/**
 * A path relative to the repository root, as reported by git status. Rejects
 * absolute paths, parent traversal and option-like values.
 */
export const repoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'path must not contain NUL')
  .refine((p) => !/^([/\\]|[a-zA-Z]:)/.test(p), 'path must be relative to the repository')
  .refine((p) => !p.split(/[/\\]/).includes('..'), 'path must not traverse outside the repository')
  .refine((p) => !p.startsWith('-'), 'path must not start with "-"')

/** Branch/remote names: shape check only; git-core validates authoritatively with check-ref-format. */
const branchName = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => !n.startsWith('-') && !n.includes('\0'), 'invalid branch name')
const remoteName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'invalid remote name')
const fullRefName = z
  .string()
  .max(300)
  .regex(/^refs\/(heads|remotes|tags)\/[^\0]+$/, 'expected refs/heads/*, refs/remotes/* or refs/tags/*')
const fullBranchRef = z
  .string()
  .max(300)
  .regex(/^refs\/(heads|remotes)\/[^\0]+$/, 'expected refs/heads/* or refs/remotes/*')

const prNumber = z.number().int().min(1).max(10_000_000)
const stashIndex = z.number().int().min(0).max(100_000)
const tagName = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => !n.startsWith('-') && !n.includes('\0'), 'invalid tag name')

const repoPaths = z.array(repoPathSchema).min(1).max(10_000)

export const diffTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unstaged'), path: repoPathSchema }),
  z.object({ kind: z.literal('staged'), path: repoPathSchema, oldPath: repoPathSchema.optional() }),
  z.object({ kind: z.literal('untracked'), path: repoPathSchema }),
  z.object({ kind: z.literal('commit'), sha: shaSchema, path: repoPathSchema, oldPath: repoPathSchema.optional() }),
  z.object({ kind: z.literal('range'), base: shaSchema, head: shaSchema, path: repoPathSchema, oldPath: repoPathSchema.optional() }),
  z.object({ kind: z.literal('worktree-compare'), sha: shaSchema, path: repoPathSchema, oldPath: repoPathSchema.optional() }),
])

export const ipcInputSchemas = {
  'repo:open': z.object({ path: absolutePath }),
  'repo:pick': z.object({}).strict(),
  'repo:recent': z.object({}).strict(),
  'repo:activate': z.object({ repoPath: absolutePath }),
  'repo:clone': z.object({ url: z.string().trim().min(1).max(2048) }),
  'repo:init': z.object({}).strict(),
  'repo:refs': z.object({ repoPath: absolutePath }),
  'repo:health': z.object({ repoPath: absolutePath }),
  'app:copy': z.object({ text: z.string().min(1).max(100_000) }),
  'app:confirm': z.object({ message: z.string().min(1).max(300), detail: z.string().max(1000).optional(), confirmLabel: z.string().min(1).max(40) }),
  'commit:reword-head': z.object({ repoPath: absolutePath, message: z.string().trim().min(1).max(100_000) }),
  'branch:delete-remote': z.object({ repoPath: absolutePath, remote: z.string().min(1).max(255), branch: branchName }),
  'branch:fast-forward': z.object({ repoPath: absolutePath, branch: branchName, to: z.string().min(1).max(1024) }),
  'branch:pull-other': z.object({ repoPath: absolutePath, branch: branchName }),
  'compare:files': z.object({ repoPath: absolutePath, sha: shaSchema }),
  'commit:save-patch': z.object({ repoPath: absolutePath, sha: shaSchema }),
  'profile:list': z.object({}).strict(),
  'profile:create': z.object({ name: z.string().trim().min(1).max(60) }),
  'profile:rename': z.object({ id: z.string().regex(/^[a-z0-9]{1,32}$/), name: z.string().trim().min(1).max(60) }),
  'profile:remove': z.object({ id: z.string().regex(/^[a-z0-9]{1,32}$/) }),
  'profile:switch': z.object({ id: z.string().regex(/^[a-z0-9]{1,32}$/) }),
  'repo:open-terminal': z.object({ repoPath: absolutePath }),
  'repo:reveal': z.object({ repoPath: absolutePath }),
  'commit:all-files': z.object({ repoPath: absolutePath, sha: shaSchema }),
  'avatar:get': z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('email'), email: z.string().min(3).max(320), source: z.enum(['github', 'gravatar']) }),
    z.object({ kind: z.literal('github-owner'), owner: z.string().min(1).max(39) }),
  ]),
  'commit:template': z.object({ repoPath: absolutePath }),
  'file:read': z.object({ repoPath: absolutePath, path: z.string().min(1).max(4096) }),
  'file:write': z.object({ repoPath: absolutePath, path: z.string().min(1).max(4096), content: z.string().max(6 * 1024 * 1024), baseHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  'branch:merge': z.object({ repoPath: absolutePath, ref: z.string().min(6).max(1024), mode: z.enum(['ff', 'no-ff', 'ff-only']).default('ff') }),
  'branch:rebase': z.object({ repoPath: absolutePath, onto: z.string().min(6).max(1024) }),
  'file:history': z.object({ repoPath: absolutePath, path: z.string().min(1).max(4096), skip: z.number().int().min(0).max(10_000_000).default(0) }),
  'repo:write-commit-graph': z.object({ repoPath: absolutePath }),
  'repo:head': z.object({ repoPath: absolutePath }),
  'log:page': z.object({
    repoPath: absolutePath,
    skip: z.number().int().min(0).max(10_000_000),
    limit: z.number().int().min(1).max(10_000),
    filter: z
      .object({
        refs: z.array(fullRefName).min(1).max(1000).optional(),
        author: z.string().trim().min(1).max(200).optional(),
        path: repoPathSchema.optional(),
      })
      .optional(),
    hidden: z.array(fullRefName).max(1000).optional(),
  }),
  'log:count': z.object({ repoPath: absolutePath, hidden: z.array(fullRefName).max(1000).optional() }),
  'commit:details': z.object({ repoPath: absolutePath, sha: shaSchema }),
  'log:search': z.object({ repoPath: absolutePath, query: z.string().trim().min(1).max(200) }),
  'status:get': z.object({ repoPath: absolutePath }),
  'index:stage': z.object({ repoPath: absolutePath, paths: repoPaths }),
  'index:unstage': z.object({ repoPath: absolutePath, paths: repoPaths }),
  'index:stage-all': z.object({ repoPath: absolutePath }),
  'index:unstage-all': z.object({ repoPath: absolutePath }),
  'worktree:discard': z.object({ repoPath: absolutePath, paths: repoPaths }),
  'diff:file': z.object({ repoPath: absolutePath, target: diffTargetSchema }),
  'diff:contents': z.object({ repoPath: absolutePath, target: diffTargetSchema }),
  'diff:apply-hunks': z.object({
    repoPath: absolutePath,
    path: repoPathSchema,
    source: z.enum(['unstaged', 'staged']),
    action: z.enum(['stage', 'unstage', 'discard']),
    selections: z
      .array(
        z.object({
          hunkIndex: z.number().int().min(0).max(100_000),
          header: z.string().min(1).max(10_000),
          lines: z.array(z.number().int().min(0).max(10_000_000)).max(1_000_000).optional(),
        }),
      )
      .min(1)
      .max(10_000),
  }),
  'conflict:get': z.object({ repoPath: absolutePath, path: repoPathSchema }),
  'conflict:describe': z.object({ repoPath: absolutePath, path: repoPathSchema }),
  'conflict:resolve-with': z.object({ repoPath: absolutePath, path: repoPathSchema, choice: z.enum(['ours', 'theirs', 'delete']) }),
  'lfs:status': z.object({ repoPath: absolutePath }),
  'lfs:install': z.object({ repoPath: absolutePath }),
  'lfs:track': z.object({ repoPath: absolutePath, pattern: z.string().min(1).max(200) }),
  'lfs:untrack': z.object({ repoPath: absolutePath, pattern: z.string().min(1).max(200) }),
  'lfs:pull': z.object({ repoPath: absolutePath }),
  'conflict:save': z.object({
    repoPath: absolutePath,
    path: repoPathSchema,
    content: z.string().max(50 * 1024 * 1024),
    markResolved: z.boolean(),
  }),
  'commit:create': z.object({
    repoPath: absolutePath,
    message: z.string().max(1_000_000).refine((m) => m.trim().length > 0, 'commit message must not be empty'),
    amend: z.boolean().default(false),
  }),
  'commit:last-message': z.object({ repoPath: absolutePath }),
  'branch:create': z.object({
    repoPath: absolutePath,
    name: branchName,
    startPoint: shaSchema,
    checkout: z.boolean(),
  }),
  'branch:checkout': z.object({ repoPath: absolutePath, ref: fullBranchRef }),
  'commit:checkout': z.object({ repoPath: absolutePath, sha: shaSchema }),
  'branch:rename': z.object({ repoPath: absolutePath, oldName: branchName, newName: branchName }),
  'branch:delete': z.object({ repoPath: absolutePath, name: branchName, force: z.boolean().default(false) }),
  'branch:set-upstream': z.object({
    repoPath: absolutePath,
    name: branchName,
    upstream: z.string().min(3).max(300).regex(/^[^\0-]/).nullable(),
  }),
  'remote:list': z.object({ repoPath: absolutePath }),
  'remote:add': z.object({ repoPath: absolutePath, name: remoteName, url: z.string().min(1).max(4096) }),
  'remote:remove': z.object({ repoPath: absolutePath, name: remoteName }),
  'remote:fetch': z.object({ repoPath: absolutePath, remote: remoteName.optional(), prune: z.boolean().default(true) }),
  'remote:pull': z.object({ repoPath: absolutePath, mode: z.enum(['ff-only', 'merge', 'rebase']) }),
  'stash:list': z.object({ repoPath: absolutePath }),
  'stash:create': z.object({
    repoPath: absolutePath,
    message: z.string().max(1000).optional(),
    includeUntracked: z.boolean().default(true),
    paths: z.array(z.string().min(1).max(4096)).max(10_000).optional(),
  }),
  'stash:branch': z.object({ repoPath: absolutePath, index: stashIndex, sha: shaSchema, name: z.string().min(1).max(255) }),
  'stash:apply-file': z.object({ repoPath: absolutePath, index: stashIndex, sha: shaSchema, path: z.string().min(1).max(4096) }),
  'stash:apply': z.object({ repoPath: absolutePath, index: stashIndex, sha: shaSchema, pop: z.boolean() }),
  'stash:drop': z.object({ repoPath: absolutePath, index: stashIndex, sha: shaSchema }),
  'stash:files': z.object({ repoPath: absolutePath, index: stashIndex, sha: shaSchema }),
  'tag:list': z.object({ repoPath: absolutePath }),
  'tag:create': z.object({
    repoPath: absolutePath,
    name: tagName,
    target: shaSchema,
    message: z.string().max(100_000).optional(),
  }),
  'tag:delete': z.object({ repoPath: absolutePath, name: tagName }),
  'tag:push': z.object({ repoPath: absolutePath, name: tagName, remote: remoteName }),
  'history:reset': z.object({ repoPath: absolutePath, target: shaSchema, mode: z.enum(['soft', 'mixed', 'hard']) }),
  'history:revert': z.object({ repoPath: absolutePath, sha: shaSchema }),
  'history:cherry-pick': z.object({ repoPath: absolutePath, shas: z.array(shaSchema).min(1).max(1000) }),
  'op:continue': z.object({ repoPath: absolutePath }),
  'op:abort': z.object({ repoPath: absolutePath }),
  'op:skip': z.object({ repoPath: absolutePath }),
  'rebase:todo': z.object({ repoPath: absolutePath, base: shaSchema }),
  'rebase:start': z.object({
    repoPath: absolutePath,
    base: shaSchema,
    todo: z
      .array(
        z.object({
          sha: shaSchema,
          action: z.enum(['pick', 'reword', 'squash', 'fixup', 'drop']),
          message: z.string().max(100_000).optional(),
        }),
      )
      .min(1)
      .max(5000),
  }),
  'blame:get': z.object({ repoPath: absolutePath, path: repoPathSchema, rev: shaSchema.optional() }),
  'worktree:list': z.object({ repoPath: absolutePath }),
  'worktree:add': z.object({
    repoPath: absolutePath,
    newBranch: branchName.optional(),
    branch: branchName.optional(),
    /** Commit for a new branch or a detached worktree (default HEAD). */
    startPoint: shaSchema.optional(),
  }),
  'worktree:remove': z.object({ repoPath: absolutePath, path: absolutePath, force: z.boolean().default(false) }),
  'submodule:list': z.object({ repoPath: absolutePath }),
  'submodule:update': z.object({ repoPath: absolutePath, paths: repoPaths.optional() }),
  'commit:signature': z.object({ repoPath: absolutePath, sha: shaSchema }),
  'reflog:get': z.object({ repoPath: absolutePath, limit: z.number().int().min(1).max(10_000).default(200) }),
  'settings:get': z.object({}).strict(),
  'settings:update': z.object({
    patch: z
      .object({
        theme: z.enum(['system', 'light', 'dark']).optional(),
        usePlatformCredentialHelper: z.boolean().optional(),
        // Only resetting is allowed from the renderer; a custom git is chosen in the main
        // process's native file picker (app:pick-git), never sent as a path.
        gitPath: z.null().optional(),
        shortcuts: z.record(z.string().regex(/^[a-z0-9.:-]{1,64}$/i), z.string().max(64)).optional(),
        autoCheckUpdates: z.boolean().optional(),
        githubClientId: z.string().regex(/^[A-Za-z0-9._-]{8,64}$/).nullable().optional(),
        avatars: z.enum(['off', 'hosting', 'gravatar']).optional(),
        zoom: z.number().min(0.5).max(2).optional(),
        gitName: z.string().trim().max(200).regex(/^[^\r\n\0]*$/).nullable().optional(),
        gitEmail: z.string().trim().max(200).regex(/^[^\r\n\0]*$/).nullable().optional(),
      })
      .strict(),
  }),
  'app:info': z.object({}).strict(),
  'app:check-update': z.object({}).strict(),
  'app:download-update': z.object({}).strict(),
  'app:install-update': z.object({}).strict(),
  'app:pick-git': z.object({}).strict(),
  'app:git-identity': z.object({}).strict(),
  'app:set-git-identity': z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().min(3).max(320) }),
  'provider:status': z.object({ repoPath: absolutePath }),
  'provider:connect': z.object({
    repoPath: absolutePath,
    token: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((t) => !/[\s\0]/.test(t), 'token must not contain whitespace'),
  }),
  'provider:disconnect': z.object({ repoPath: absolutePath }),
  'provider:issues': z.object({ repoPath: absolutePath }),
  'provider:pulls': z.object({ repoPath: absolutePath, state: z.enum(['open', 'all']).default('open') }),
  'provider:checks': z.object({ repoPath: absolutePath, sha: shaSchema }),
  'provider:accounts': z.object({}).strict(),
  'undo:state': z.object({ repoPath: absolutePath }),
  'undo:undo': z.object({ repoPath: absolutePath }),
  'undo:redo': z.object({ repoPath: absolutePath }),
  'provider:hosted-repos': z.object({
    kind: z.enum(['github', 'gitlab', 'bitbucket', 'azure']),
    host: z.string().regex(/^[a-z0-9.-]+(?::\d{1,5})?$/i).max(255),
  }),
  'provider:pr': z.object({ repoPath: absolutePath, number: prNumber }),
  'provider:pr-comments': z.object({ repoPath: absolutePath, number: prNumber }),
  'provider:pr-comment': z.object({ repoPath: absolutePath, number: prNumber, body: z.string().trim().min(1).max(65_536) }),
  'provider:pr-line-comment': z.object({
    repoPath: absolutePath,
    number: prNumber,
    path: z.string().min(1).max(4096),
    oldPath: z.string().min(1).max(4096).optional(),
    line: z.number().int().min(1).max(10_000_000),
    side: z.enum(['old', 'new']),
    body: z.string().trim().min(1).max(65_536),
    headSha: shaSchema,
  }),
  'provider:pr-review': z.object({
    repoPath: absolutePath,
    number: prNumber,
    event: z.enum(['approve', 'comment', 'request-changes']),
    body: z.string().max(65_536),
  }),
  'provider:pr-merge': z.object({
    repoPath: absolutePath,
    number: prNumber,
    method: z.enum(['merge', 'squash', 'rebase']),
    expectedHeadSha: shaSchema.optional(),
    deleteSourceBranch: z.boolean(),
  }),
  'provider:pr-changes': z.object({ repoPath: absolutePath, number: prNumber }),
  'provider:signin-start': z.object({ repoPath: absolutePath }),
  'provider:signin-finish': z.object({ repoPath: absolutePath }),
  'provider:signin-cancel': z.object({}).strict(),
  'provider:create-pr': z.object({
    repoPath: absolutePath,
    title: z.string().trim().min(1).max(256),
    body: z.string().max(65_536),
    sourceBranch: branchName,
    targetBranch: branchName,
    draft: z.boolean(),
  }),
  'credentials:respond': z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    answer: z.string().max(4096).nullable(),
    remember: z.boolean().default(false),
  }),
  'op:cancel': z.object({}).strict(),
  'remote:push': z.object({
    repoPath: absolutePath,
    branch: branchName,
    remote: remoteName,
    setUpstream: z.boolean().default(false),
    force: z.enum(['none', 'with-lease']).default('none'),
  }),
} as const satisfies Record<IpcChannel, z.ZodType>

export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcInputSchemas)[C]>

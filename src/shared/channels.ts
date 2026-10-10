/** Dependency-free channel lists. Imported by the sandboxed preload as an allowlist. */

export const IPC_CHANNELS = [
  'repo:open',
  'repo:pick',
  'repo:recent',
  'repo:refs',
  'repo:head',
  'log:page',
  'log:search',
  'commit:details',
  'status:get',
  'index:stage',
  'index:unstage',
  'index:stage-all',
  'index:unstage-all',
  'worktree:discard',
  'diff:file',
  'commit:create',
  'commit:last-message',
  'branch:create',
  'branch:checkout',
  'commit:checkout',
  'branch:rename',
  'branch:delete',
  'branch:set-upstream',
  'remote:list',
  'remote:add',
  'remote:remove',
  'remote:fetch',
  'remote:pull',
  'remote:push',
  'credentials:respond',
  'op:cancel',
] as const
export type IpcChannel = (typeof IPC_CHANNELS)[number]

export const IPC_EVENTS = [
  'menu:open-repository',
  'repo:opened',
  'repo:changed',
  'credentials:request',
  'credentials:cancel',
  'op:progress',
] as const
export type IpcEventName = (typeof IPC_EVENTS)[number]

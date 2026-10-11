import type { ProviderKind, RemoteInfo } from '@shared/types'

const enc = (s: string): string => s.split('/').map(encodeURIComponent).join('/')

/** Browser URL of a branch on its hosting service, or null when the remote isn't a known service. */
export function branchUrl(remote: RemoteInfo | undefined, branch: string): string | null {
  const h = remote?.hosted
  if (!h) return null
  const base = h.webUrl.replace(/\/$/, '')
  const map: Record<ProviderKind, string> = {
    github: `${base}/tree/${enc(branch)}`,
    gitlab: `${base}/-/tree/${enc(branch)}`,
    bitbucket: `${base}/src/${enc(branch)}`,
    azure: `${base}?version=GB${encodeURIComponent(branch)}`,
  }
  return map[h.kind]
}

/** Browser URL of a commit on its hosting service. */
export function commitUrl(remote: RemoteInfo | undefined, sha: string): string | null {
  const h = remote?.hosted
  if (!h || !/^[0-9a-f]{7,64}$/i.test(sha)) return null
  const base = h.webUrl.replace(/\/$/, '')
  const map: Record<ProviderKind, string> = {
    github: `${base}/commit/${sha}`,
    gitlab: `${base}/-/commit/${sha}`,
    bitbucket: `${base}/commits/${sha}`,
    azure: `${base}/commit/${sha}`,
  }
  return map[h.kind]
}

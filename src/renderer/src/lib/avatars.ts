import { useQuery } from '@tanstack/react-query'
import { call } from './api'
import { useRemotes } from './queries'

export type AvatarSource = 'github' | 'gravatar' | null

/** Where author avatars come from for this repository, per the Avatars setting. */
export function useAvatarSource(repoPath: string): AvatarSource {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => call('settings:get', {}) })
  const remotes = useRemotes(repoPath)
  const mode = settings.data?.avatars ?? 'hosting'
  if (mode === 'off') return null
  if (mode === 'gravatar') return 'gravatar'
  return remotes.data?.some((r) => r.hosted?.kind === 'github') ? 'github' : null
}

export function useEmailAvatar(email: string, source: AvatarSource): string | null {
  const q = useQuery({
    queryKey: ['avatar', source, email.toLowerCase()],
    queryFn: () => call('avatar:get', { kind: 'email', email, source: source! }),
    enabled: !!source && email.includes('@'),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  })
  return q.data ?? null
}

export function useOwnerAvatar(kind: string | undefined, owner: string | undefined): string | null {
  const q = useQuery({
    queryKey: ['avatar', 'owner', kind, owner],
    queryFn: () => call('avatar:get', { kind: 'github-owner', owner: owner! }),
    enabled: kind === 'github' && !!owner,
    staleTime: Infinity,
    retry: false,
  })
  return q.data ?? null
}

/** Up to two initials for an author name. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
  const s = parts.length >= 2 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? '?').slice(0, 2)
  return s.toUpperCase()
}

/** A stable hue for a name, so the same author always gets the same color. */
export function nameHue(name: string): number {
  let h = 0
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 360
}

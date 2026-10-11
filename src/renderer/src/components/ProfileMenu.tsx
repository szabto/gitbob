import { useQuery, useQueryClient } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useUiStore } from '../state/ui'

/** Current profile in the tab bar; switch, create or manage profiles. */
export function ProfileMenu({ onManage }: { onManage: () => void }) {
  const qc = useQueryClient()
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => call('profile:list', {}) })
  const { openMenu, ask, showError } = useUiStore.getState()
  const active = profiles.data?.profiles.find((p) => p.id === profiles.data?.active)
  if (!profiles.data) return null

  const switchTo = (id: string): void => void call('profile:switch', { id }).catch(showError)
  const create = async (): Promise<void> => {
    const name = await ask({ title: 'New profile', label: 'Profile name', placeholder: 'Work, Personal, …', confirmLabel: 'Create and switch' })
    if (!name) return
    try {
      const p = await call('profile:create', { name })
      await qc.invalidateQueries({ queryKey: ['profiles'] })
      switchTo(p.id)
    } catch (e) {
      showError(e)
    }
  }

  return (
    <button
      data-testid="profile-menu"
      title="Profile: its own settings, open repositories and accounts"
      onClick={(e) =>
        openMenu(e.clientX, e.clientY, [
          ...profiles.data!.profiles.map((p) => ({
            label: `${p.id === profiles.data!.active ? '✓ ' : ' '}${p.name}`,
            disabled: p.id === profiles.data!.active,
            onSelect: () => switchTo(p.id),
          })),
          'separator',
          { label: 'New profile…', onSelect: () => void create() },
          { label: 'Manage profiles…', onSelect: onManage },
        ])
      }
      className="mb-0.5 ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-sm text-muted hover:bg-panel hover:text-fg"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="5.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M2.5 14c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      <span data-testid="profile-name">{active?.name ?? 'Default'}</span>
      <span aria-hidden className="text-[10px]">
        ▾
      </span>
    </button>
  )
}

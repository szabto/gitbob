import { useSyncExternalStore } from 'react'

/** Effective theme: data-theme on <html> wins; "system"/unset follows prefers-color-scheme. */
function isDark(): boolean {
  const t = document.documentElement.dataset.theme
  if (t === 'dark') return true
  if (t === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  mq.addEventListener('change', cb)
  return () => {
    mo.disconnect()
    mq.removeEventListener('change', cb)
  }
}

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, isDark)
}

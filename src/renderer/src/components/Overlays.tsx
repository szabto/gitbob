import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUiStore } from '../state/ui'

export function ContextMenu() {
  const menu = useUiStore((s) => s.menu)
  const closeMenu = useUiStore((s) => s.closeMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 4),
      y: Math.min(menu.y, window.innerHeight - r.height - 4),
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = (): void => closeMenu()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, closeMenu])

  if (!menu) return null
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="context-menu"
      className="fixed z-50 min-w-48 rounded-md border border-border bg-panel-2 py-1 shadow-xl shadow-black/50"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="my-1 border-t border-border" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              closeMenu()
              item.onSelect()
            }}
            className={`block w-full px-3 py-1 text-left hover:bg-accent/20 disabled:opacity-40 ${
              item.danger ? 'text-red-300' : ''
            }`}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}

export function PromptDialog() {
  const prompt = useUiStore((s) => s.prompt)
  const closePrompt = useUiStore((s) => s.closePrompt)
  if (!prompt) return null
  // Keyed so internal state resets for each prompt.
  return <PromptForm key={`${prompt.title}:${prompt.initialValue ?? ''}`} prompt={prompt} onClose={closePrompt} />
}

function PromptForm({
  prompt,
  onClose,
}: {
  prompt: NonNullable<ReturnType<typeof useUiStore.getState>['prompt']>
  onClose: (v: string | null) => void
}) {
  const [value, setValue] = useState(prompt.initialValue ?? prompt.choices?.[0] ?? '')
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[15vh]"
      onMouseDown={() => onClose(null)}
    >
      <form
        role="dialog"
        aria-label={prompt.title}
        data-testid="prompt-dialog"
        className="w-[420px] rounded-lg border border-border bg-panel p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onClose(value.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose(null)
        }}
      >
        <h2 className="mb-3 font-semibold">{prompt.title}</h2>
        <label className="mb-1 block text-xs text-muted">{prompt.label}</label>
        {prompt.choices ? (
          <select
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={prompt.label}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 outline-none focus:border-accent"
          >
            {prompt.choices.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        ) : (
          <input
            autoFocus
            value={value}
            placeholder={prompt.placeholder}
            onChange={(e) => setValue(e.target.value)}
            aria-label={prompt.label}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono outline-none focus:border-accent"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded border border-border px-3 py-1 hover:bg-panel-2" onClick={() => onClose(null)}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="rounded bg-accent px-3 py-1 font-medium text-[#0b1220] disabled:opacity-40"
          >
            {prompt.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}

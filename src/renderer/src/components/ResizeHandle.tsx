/**
 * Drag handle on a column edge. `onResize` receives the pointer's horizontal movement since the
 * drag started; `edge` says which side of the column the handle sits on.
 */
export function ResizeHandle({ edge, label, onStart, onResize }: { edge: 'left' | 'right'; label: string; onStart: () => void; onResize: (dx: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className={`absolute top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/40 ${edge === 'right' ? '-right-0.5' : '-left-0.5'}`}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        onStart()
        const move = (ev: PointerEvent): void => onResize(ev.clientX - startX)
        const up = (): void => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
    />
  )
}

import { useRef, type ReactNode } from 'react'
import { usePaneWidth, type Pane } from '../lib/panel-widths'

/**
 * Drag handle on a column edge. `onResize` receives the pointer's horizontal movement since the
 * drag started; `edge` says which side of the column the handle sits on. Double-clicking calls
 * `onReset` (back to the default width) when given.
 */
export function ResizeHandle({
  edge,
  label,
  onStart,
  onResize,
  onReset,
}: {
  edge: 'left' | 'right'
  label: string
  onStart: () => void
  onResize: (dx: number) => void
  onReset?: () => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={onReset ? `${label} (double-click to reset)` : label}
      onDoubleClick={onReset}
      className={`absolute top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/40 ${edge === 'right' ? '-right-0.5' : '-left-0.5'}`}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        onStart()
        const move = (ev: PointerEvent): void => onResize(ev.clientX - startX)
        // Keep the resize cursor and stop text selection while dragging past the handle.
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        const up = (): void => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          el.removeEventListener('pointercancel', up)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
        el.addEventListener('pointercancel', up)
      }}
    />
  )
}

/**
 * A side pane whose width the user drags from its inner edge: the sidebar (left of the graph)
 * or the details pane (right of it). The width is shared by every panel shown in that pane.
 */
export function ResizablePane({ pane, label, testId, children }: { pane: Pane; label: string; testId?: string; children: ReactNode }) {
  const [width, setWidth] = usePaneWidth(pane)
  const start = useRef(width)
  const edge = pane === 'sidebar' ? 'right' : 'left'
  return (
    <div className="relative flex min-h-0 shrink-0" style={{ width }} data-testid={testId}>
      {children}
      <ResizeHandle
        edge={edge}
        label={label}
        onStart={() => {
          start.current = width
        }}
        onResize={(dx) => setWidth(start.current + (edge === 'right' ? dx : -dx))}
        onReset={() => setWidth(null)}
      />
    </div>
  )
}

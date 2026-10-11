import type { RemoteInfo } from '@shared/types'
import { endDrag, startDrag, useDropTarget } from '../lib/dnd'
import { useOwnerAvatar } from '../lib/avatars'
import type { RefLabel } from '../lib/ref-labels'

function LaptopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-label="on this computer" role="img" className="shrink-0">
      <rect x="2.5" y="3" width="11" height="7.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1 12.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function ServerIcon({ label }: { label: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-label={label} role="img" className="shrink-0">
      <path d="M4.5 12.5h7a3 3 0 0 0 .3-6A4 4 0 0 0 4.1 7 2.8 2.8 0 0 0 4.5 12.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

function TagIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <path d="M2 2h6l6 6-6 6-6-6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="5.5" cy="5.5" r="1.2" fill="currentColor" />
    </svg>
  )
}

/** The project icon of a remote: the hosting owner's picture, or a generic server icon. */
function RemoteIcon({ remote, info }: { remote: string; info: RemoteInfo | undefined }) {
  const src = useOwnerAvatar(info?.hosted?.kind, info?.hosted?.owner)
  const label = `on ${remote}`
  if (src) return <img src={src} alt={label} title={label} width={14} height={14} className="shrink-0 rounded-sm" />
  return <ServerIcon label={label} />
}

/** A branch / tag label in the graph: name, ✓ when checked out, 💻 when local, remote project icons. */
export function RefLabelPill({ label, remotes }: { label: RefLabel; remotes: RemoteInfo[] }) {
  const drop = useDropTarget(label.primary)
  const draggable = label.kind !== 'other'
  const title = [label.local?.name, ...label.remotes.map((r) => r.ref.name), label.tag?.name].filter(Boolean).join('\n')
  const tone =
    label.kind === 'tag'
      ? 'border-warn/60 bg-warn/15'
      : label.local
        ? 'border-info/60 bg-info/15'
        : 'border-purple/60 bg-purple/15'
  return (
    <span
      draggable={draggable}
      onDragStart={draggable ? (e) => startDrag(e, { kind: 'ref', ref: label.primary }) : undefined}
      onDragEnd={endDrag}
      {...(draggable ? drop.props : {})}
      data-testid="ref-label"
      data-ref={label.primary.name}
      data-local={label.local ? 'true' : undefined}
      data-remotes={label.remotes.map((r) => r.remote).join(' ') || undefined}
      title={title}
      className={`inline-flex max-w-full min-w-0 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] leading-[18px] text-fg ${tone} ${
        label.current ? 'font-semibold ring-1 ring-fg/60' : ''
      } ${drop.isOver ? 'ring-2 ring-accent' : ''} ${draggable ? 'cursor-grab' : ''}`}
    >
      {label.current && <span aria-label="checked out">✓</span>}
      {label.kind === 'tag' && <TagIcon />}
      <span className="truncate">{label.name}</span>
      {label.local && <LaptopIcon />}
      {label.remotes.map((r) => (
        <RemoteIcon key={r.remote} remote={r.remote} info={remotes.find((x) => x.name === r.remote)} />
      ))}
    </span>
  )
}

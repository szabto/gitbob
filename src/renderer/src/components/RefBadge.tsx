import type { GitRef } from '@shared/types'

const kindStyle: Record<GitRef['kind'], string> = {
  head: 'border-info/50 bg-info/15 text-info',
  remote: 'border-purple/50 bg-purple/15 text-purple',
  tag: 'border-warn/50 bg-warn/15 text-warn',
  stash: 'border-muted/50 bg-muted/15 text-fg',
  other: 'border-muted/50 bg-muted/15 text-fg',
}

export function RefBadge({ gitRef, current }: { gitRef: GitRef; current: boolean }) {
  return (
    <span
      title={gitRef.name}
      data-testid="ref-badge"
      data-ref={gitRef.name}
      className={`inline-flex max-w-48 shrink-0 items-center gap-1 truncate rounded border px-1.5 text-[11px] leading-[18px] ${
        kindStyle[gitRef.kind]
      } ${current ? 'font-semibold ring-1 ring-fg/60' : ''}`}
    >
      {gitRef.kind === 'tag' ? '🏷 ' : ''}
      {gitRef.shortName}
    </span>
  )
}

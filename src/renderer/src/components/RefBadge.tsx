import type { GitRef } from '@shared/types'

const kindStyle: Record<GitRef['kind'], string> = {
  head: 'border-sky-500/50 bg-sky-500/15 text-sky-200',
  remote: 'border-violet-500/50 bg-violet-500/15 text-violet-200',
  tag: 'border-amber-500/50 bg-amber-500/15 text-amber-200',
  stash: 'border-zinc-500/50 bg-zinc-500/15 text-zinc-200',
  other: 'border-zinc-500/50 bg-zinc-500/15 text-zinc-200',
}

export function RefBadge({ gitRef, current }: { gitRef: GitRef; current: boolean }) {
  return (
    <span
      title={gitRef.name}
      data-testid="ref-badge"
      data-ref={gitRef.name}
      className={`inline-flex max-w-48 shrink-0 items-center gap-1 truncate rounded border px-1.5 text-[11px] leading-[18px] ${
        kindStyle[gitRef.kind]
      } ${current ? 'font-semibold ring-1 ring-white/60' : ''}`}
    >
      {gitRef.kind === 'tag' ? '🏷 ' : ''}
      {gitRef.shortName}
    </span>
  )
}

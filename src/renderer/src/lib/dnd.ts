import { createContext, useContext, useState } from 'react'
import type { GitRef } from '@shared/types'
import type { MenuEntry } from '../state/ui'
import type { useRepoActions } from './actions'

/** What is being dragged: a branch/tag, or a commit row. */
export type DragPayload = { kind: 'ref'; ref: GitRef } | { kind: 'commit'; sha: string; subject: string }

const MIME = 'application/x-gitbob'
// dataTransfer contents can't be read during dragover, so the payload is also kept here.
let current: DragPayload | null = null

export function startDrag(e: React.DragEvent, payload: DragPayload): void {
  e.stopPropagation()
  current = payload
  e.dataTransfer.setData(MIME, JSON.stringify(payload))
  e.dataTransfer.setData('text/plain', payload.kind === 'ref' ? payload.ref.shortName : payload.sha)
  e.dataTransfer.effectAllowed = 'move'
}

export function endDrag(): void {
  current = null
}

function payloadOf(e: React.DragEvent): DragPayload | null {
  if (current) return current
  try {
    return JSON.parse(e.dataTransfer.getData(MIME)) as DragPayload
  } catch {
    return null
  }
}

export interface DropContext {
  currentRef: string | null
  actions: ReturnType<typeof useRepoActions>
}

/**
 * Menu offered when `source` is dropped on branch/tag `target`. Merging and rebasing always act
 * on the checked-out branch, so one side of the drop must be it.
 */
export function dropEntries(source: DragPayload, target: GitRef, ctx: DropContext): MenuEntry[] {
  const cur = ctx.currentRef
  const curName = cur?.replace(/^refs\/heads\//, '') ?? null
  if (source.kind === 'commit') {
    if (target.name === cur) return [{ label: `Cherry-pick ${source.sha.slice(0, 7)} onto ${curName}`, onSelect: () => void ctx.actions.cherryPick(source.sha) }]
    return [{ label: `Check out ${target.shortName} first to cherry-pick onto it`, disabled: true, onSelect: () => {} }]
  }
  const s = source.ref
  if (s.name === target.name || !cur || !curName) return []
  if (target.name === cur) {
    return [
      { label: `Merge ${s.shortName} into ${curName}`, onSelect: () => void ctx.actions.merge(s) },
      { label: `Rebase ${curName} onto ${s.shortName}`, onSelect: () => void ctx.actions.rebase(s) },
    ]
  }
  if (s.name === cur) {
    return [
      { label: `Rebase ${curName} onto ${target.shortName}`, onSelect: () => void ctx.actions.rebase(target) },
      { label: `Merge ${target.shortName} into ${curName}`, onSelect: () => void ctx.actions.merge(target) },
    ]
  }
  return [{ label: `Check out ${s.shortName} or ${target.shortName} first to merge or rebase`, disabled: true, onSelect: () => {} }]
}

export const DropHandler = createContext<((e: React.DragEvent, target: GitRef) => void) | null>(null)

/** Props that make an element a drop target for branches and commits. */
export function useDropTarget(target: GitRef): {
  isOver: boolean
  props: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragEnter' | 'onDragLeave' | 'onDrop'>
} {
  const onDrop = useContext(DropHandler)
  const [isOver, setOver] = useState(false)
  const accepts = (e: React.DragEvent): boolean => {
    if (!onDrop || !e.dataTransfer.types.includes(MIME)) return false
    const p = current
    return !(p?.kind === 'ref' && p.ref.name === target.name)
  }
  return {
    isOver,
    props: {
      onDragEnter: (e) => {
        if (accepts(e)) setOver(true)
      },
      onDragOver: (e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDragLeave: () => setOver(false),
      onDrop: (e) => {
        setOver(false)
        if (!accepts(e)) return
        e.preventDefault()
        e.stopPropagation()
        onDrop!(e, target)
        endDrag()
      },
    },
  }
}

/** Builds the drop handler for a repository view: opens the drop menu at the pointer. */
export function makeDropHandler(ctx: DropContext, openMenu: (x: number, y: number, items: MenuEntry[]) => void) {
  return (e: React.DragEvent, target: GitRef): void => {
    const p = payloadOf(e)
    if (!p) return
    const entries = dropEntries(p, target, ctx)
    if (entries.length) openMenu(e.clientX, e.clientY, entries)
  }
}

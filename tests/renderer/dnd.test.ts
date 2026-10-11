import { describe, expect, it, vi } from 'vitest'
import type { GitRef } from '@shared/types'
import { dropEntries, type DropContext } from '../../src/renderer/src/lib/dnd'
import type { MenuItem } from '../../src/renderer/src/state/ui'

const ref = (name: string, kind: GitRef['kind'] = 'head'): GitRef =>
  ({ name, shortName: name.replace(/^refs\/(heads|remotes|tags)\//, ''), kind, target: 'a'.repeat(40) }) as GitRef

function ctx(currentRef: string | null) {
  const actions = { merge: vi.fn(), rebase: vi.fn(), cherryPick: vi.fn() }
  return { ctx: { currentRef, actions } as unknown as DropContext, actions }
}
const labels = (entries: ReturnType<typeof dropEntries>) => entries.map((e) => (e === 'separator' ? '-' : e.label))
const run = (entries: ReturnType<typeof dropEntries>, i: number) => (entries[i] as MenuItem).onSelect()

describe('dropEntries', () => {
  const main = ref('refs/heads/main')
  const feature = ref('refs/heads/feature/login')

  it('dropping a branch on the current branch offers merge and rebase', () => {
    const { ctx: c, actions } = ctx(main.name)
    const e = dropEntries({ kind: 'ref', ref: feature }, main, c)
    expect(labels(e)).toEqual(['Merge feature/login into main', 'Rebase main onto feature/login'])
    run(e, 0)
    expect(actions.merge).toHaveBeenCalledWith(feature)
    run(e, 1)
    expect(actions.rebase).toHaveBeenCalledWith(feature)
  })

  it('dropping the current branch on another offers rebase onto it first', () => {
    const { ctx: c, actions } = ctx(main.name)
    const origin = ref('refs/remotes/origin/main', 'remote')
    const e = dropEntries({ kind: 'ref', ref: main }, origin, c)
    expect(labels(e)).toEqual(['Rebase main onto origin/main', 'Merge origin/main into main'])
    run(e, 0)
    expect(actions.rebase).toHaveBeenCalledWith(origin)
  })

  it('needs the current branch on one side; nothing for itself or a detached HEAD', () => {
    const other = ref('refs/heads/other')
    expect(labels(dropEntries({ kind: 'ref', ref: feature }, other, ctx(main.name).ctx))).toEqual([
      'Check out feature/login or other first to merge or rebase',
    ])
    expect(dropEntries({ kind: 'ref', ref: main }, main, ctx(main.name).ctx)).toEqual([])
    expect(dropEntries({ kind: 'ref', ref: feature }, main, ctx(null).ctx)).toEqual([])
  })

  it('dropping a commit on the current branch cherry-picks it', () => {
    const { ctx: c, actions } = ctx(main.name)
    const sha = 'b'.repeat(40)
    const e = dropEntries({ kind: 'commit', sha, subject: 'Fix' }, main, c)
    expect(labels(e)).toEqual(['Cherry-pick bbbbbbb onto main'])
    run(e, 0)
    expect(actions.cherryPick).toHaveBeenCalledWith(sha)
    expect((dropEntries({ kind: 'commit', sha, subject: 'Fix' }, feature, c)[0] as MenuItem).disabled).toBe(true)
  })
})

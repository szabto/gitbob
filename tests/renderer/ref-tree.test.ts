import { describe, expect, it } from 'vitest'
import type { GitRef } from '../../src/shared/types'
import { buildRefTree } from '../../src/renderer/src/components/RefTree'

const ref = (shortName: string): GitRef => ({ name: `refs/heads/${shortName}`, shortName, kind: 'head', target: 'a'.repeat(40) })

describe('buildRefTree', () => {
  it('groups by slash segments and keeps leaves at their folder', () => {
    const tree = buildRefTree([ref('main'), ref('feature/login'), ref('feature/ui/dark'), ref('fix/x')], (r) => r.shortName)
    expect(tree.refs.map((r) => r.shortName)).toEqual(['main'])
    expect([...tree.folders.keys()].sort()).toEqual(['feature', 'fix'])
    const feature = tree.folders.get('feature')!
    expect(feature.refs.map((r) => r.shortName)).toEqual(['feature/login'])
    expect(feature.folders.get('ui')!.path).toBe('feature/ui')
    expect(feature.folders.get('ui')!.refs.map((r) => r.shortName)).toEqual(['feature/ui/dark'])
  })

  it('uses the given name function (e.g. remote branches without the remote prefix)', () => {
    const r = { ...ref('origin/feature/x'), kind: 'remote' as const }
    const tree = buildRefTree([r], (x) => x.shortName.slice('origin/'.length))
    expect(tree.folders.get('feature')!.refs).toEqual([r])
  })
})

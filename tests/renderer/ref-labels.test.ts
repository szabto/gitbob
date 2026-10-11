import { describe, expect, it } from 'vitest'
import type { GitRef } from '@shared/types'
import { buildRefLabels } from '../../src/renderer/src/lib/ref-labels'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const head = (name: string, target: string, upstream?: string): GitRef =>
  ({ name: `refs/heads/${name}`, shortName: name, kind: 'head', target, ...(upstream ? { upstream } : {}) }) as GitRef
const remote = (name: string, target: string): GitRef => ({ name: `refs/remotes/${name}`, shortName: name, kind: 'remote', target }) as GitRef
const tag = (name: string, target: string): GitRef => ({ name: `refs/tags/${name}`, shortName: name, kind: 'tag', target }) as GitRef

describe('buildRefLabels', () => {
  it('merges a local branch with its remote when both are on the same commit', () => {
    const labels = buildRefLabels([head('new-design', A, 'refs/remotes/origin/new-design'), remote('origin/new-design', A), remote('origin/HEAD', A)], 'refs/heads/new-design')
    const l = labels.get(A)!
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ name: 'new-design', current: true, remotes: [{ remote: 'origin' }] })
    expect(l[0]!.local?.name).toBe('refs/heads/new-design')
  })

  it('keeps them apart when local is ahead: laptop label on one commit, remote label on the other', () => {
    const labels = buildRefLabels([head('new-design', A, 'refs/remotes/origin/new-design'), remote('origin/new-design', B)], 'refs/heads/new-design')
    expect(labels.get(A)!.map((l) => [l.name, !!l.local, l.remotes.length])).toEqual([['new-design', true, 0]])
    expect(labels.get(B)!.map((l) => [l.name, !!l.local, l.remotes.map((r) => r.remote)])).toEqual([['new-design', false, ['origin']]])
  })

  it('groups the same branch on several remotes, and orders current, local, remote, tags', () => {
    const labels = buildRefLabels(
      [tag('v1', A), remote('origin/feature', A), remote('upstream/feature', A), head('zeta', A), head('main', A, 'refs/remotes/origin/main')],
      'refs/heads/main',
    )
    expect(labels.get(A)!.map((l) => `${l.name}:${l.local ? 'L' : ''}${l.remotes.map((r) => r.remote).join('+')}`)).toEqual([
      'main:L',
      'zeta:L',
      'feature:origin+upstream',
      'v1:',
    ])
  })
})

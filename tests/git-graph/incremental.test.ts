import { describe, expect, it } from 'vitest'
import { computeGraphLayout, type LayoutCommit } from '@git-graph/layout'
import { IncrementalLayout } from '@git-graph/incremental'

const chain = (n: number, prefix = 'c'): LayoutCommit[] =>
  Array.from({ length: n }, (_, i) => ({ sha: `${prefix}${n - i}`, parents: n - i > 1 ? [`${prefix}${n - i - 1}`] : [] }))

describe('IncrementalLayout', () => {
  it('appending pages gives the same result as a full layout', () => {
    const all: LayoutCommit[] = [
      { sha: 'm', parents: ['b', 'f'] },
      { sha: 'f', parents: ['a'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]
    const inc = new IncrementalLayout()
    inc.update(all.slice(0, 2))
    expect(inc.update(all)).toEqual(computeGraphLayout(all))
  })

  it('rebuilds when the list changes other than by appending', () => {
    const inc = new IncrementalLayout()
    inc.update(chain(5))
    const changed = chain(6) // new commit at the top
    expect(inc.update(changed)).toEqual(computeGraphLayout(changed))
    const other = chain(3, 'x')
    expect(inc.update(other)).toEqual(computeGraphLayout(other))
    expect(inc.update([])).toEqual(computeGraphLayout([]))
  })

  it('is idempotent for the same input and returns a fresh object', () => {
    const inc = new IncrementalLayout()
    const list = chain(10)
    const a = inc.update(list)
    const b = inc.update(list)
    expect(b).not.toBe(a)
    expect(b.rows).toHaveLength(10)
    expect(b).toEqual(computeGraphLayout(list))
  })
})

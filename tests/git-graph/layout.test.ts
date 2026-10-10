import { afterAll, describe, expect, it } from 'vitest'
import { computeGraphLayout, GraphLayoutBuilder, type GraphLayout, type LayoutCommit } from '@git-graph/layout'
import { getCommitPage } from '@git-core/log'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterAll(cleanupFixtures)

const c = (sha: string, ...parents: string[]): LayoutCommit => ({ sha, parents })

/**
 * Structural invariant: the lanes leaving the bottom of row r must be exactly
 * the lanes entering the top of row r+1, so drawn rows connect seamlessly.
 * Also every outgoing edge must eventually terminate in its parent's node
 * (when the parent is part of the layout).
 */
function assertConsistent(layout: GraphLayout, commits: readonly LayoutCommit[]): void {
  const rows = layout.rows
  for (let r = 0; r < rows.length - 1; r++) {
    const bottom = new Set<number>()
    for (const s of rows[r]!.passThrough) bottom.add(s.to)
    for (const s of rows[r]!.outgoing) bottom.add(s.to)
    const top = new Set<number>()
    for (const s of rows[r + 1]!.passThrough) top.add(s.from)
    for (const s of rows[r + 1]!.incoming) top.add(s.from)
    expect([...top].sort(), `row ${r} -> ${r + 1}`).toEqual([...bottom].sort())
  }
  // Follow each lane from a parent edge downwards and check it lands on the parent.
  const index = new Map(commits.map((cm, i) => [cm.sha, i]))
  rows.forEach((row, r) => {
    commits[r]!.parents.forEach((p, k) => {
      const target = index.get(p)
      if (target === undefined) return
      let col = row.outgoing[k]!.to
      for (let rr = r + 1; rr < target; rr++) {
        const pass = rows[rr]!.passThrough.find((s) => s.from === col)
        expect(pass, `edge ${row.sha}->${p} interrupted at row ${rr}`).toBeDefined()
        col = pass!.to
      }
      expect(rows[target]!.incoming.some((s) => s.from === col)).toBe(true)
      expect(rows[target]!.column).toBe(rows[target]!.incoming[0]!.to)
    })
  })
  for (const row of rows) expect(row.column).toBeLessThan(layout.width)
}

describe('computeGraphLayout', () => {
  it('lays out a linear history in a single lane', () => {
    const commits = [c('d', 'c'), c('c', 'b'), c('b', 'a'), c('a')]
    const layout = computeGraphLayout(commits)
    expect(layout.rows.map((r) => r.column)).toEqual([0, 0, 0, 0])
    expect(layout.width).toBe(1)
    expect(layout.rows[3]!.outgoing).toEqual([])
    assertConsistent(layout, commits)
  })

  it('places a merged feature branch in a second lane and merges back', () => {
    // m merges f2 into main; main: m - b - a ; feature: f2 - f1 - a
    const commits = [c('m', 'b', 'f2'), c('f2', 'f1'), c('b', 'a'), c('f1', 'a'), c('a')]
    const layout = computeGraphLayout(commits)
    expect(layout.rows[0]!.isMerge).toBe(true)
    expect(layout.rows.map((r) => r.column)).toEqual([0, 1, 0, 1, 0])
    expect(layout.width).toBe(2)
    // f1's parent is already expected in lane 0, so its edge joins that lane immediately.
    expect(layout.rows[3]!.outgoing).toEqual([{ from: 1, to: 0, color: layout.rows[3]!.color }])
    expect(layout.rows[4]!.incoming.map((s) => s.from)).toEqual([0])
    assertConsistent(layout, commits)
  })

  it('gives unrelated branch tips their own lanes and colors', () => {
    const commits = [c('x', 'a'), c('y', 'a'), c('a')]
    const layout = computeGraphLayout(commits)
    expect(layout.rows[0]!.column).toBe(0)
    expect(layout.rows[1]!.column).toBe(1)
    expect(layout.rows[0]!.color).not.toBe(layout.rows[1]!.color)
    assertConsistent(layout, commits)
  })

  it('handles octopus merges and multiple roots', () => {
    const commits = [c('o', 'a', 'b', 'd'), c('d'), c('b'), c('a')]
    const layout = computeGraphLayout(commits)
    expect(layout.rows[0]!.outgoing).toHaveLength(3)
    expect(layout.width).toBe(3)
    assertConsistent(layout, commits)
  })

  it('reuses freed lanes', () => {
    const commits = [c('m2', 'm1', 'g'), c('g', 'm1'), c('m1', 'b', 'f'), c('f', 'b'), c('b')]
    const layout = computeGraphLayout(commits)
    expect(layout.width).toBe(2)
    assertConsistent(layout, commits)
  })

  it('tolerates parents outside the loaded page (lanes run off the bottom)', () => {
    const commits = [c('b', 'a'), c('y', 'x')]
    const layout = computeGraphLayout(commits)
    expect(layout.rows[1]!.passThrough.map((s) => s.from)).toEqual([0])
    assertConsistent(layout, commits)
  })

  it('incremental append matches a full layout', () => {
    const commits = randomDag(400, 7)
    const full = computeGraphLayout(commits)
    const b = new GraphLayoutBuilder()
    b.append(commits.slice(0, 123))
    b.append(commits.slice(123))
    expect(b.result()).toEqual(full)
  })

  it('stays consistent on random DAGs', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const commits = randomDag(250, seed)
      assertConsistent(computeGraphLayout(commits), commits)
    }
  })

  it('matches the original (pre-optimisation) algorithm exactly on random DAGs', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const commits = randomDag(300, seed)
      const ref = referenceLayout(commits)
      const got = computeGraphLayout(commits)
      expect(got.width, `seed ${seed}`).toBe(ref.width)
      expect(JSON.parse(JSON.stringify(got.rows))).toEqual(ref.rows)
    }
    // Duplicate parents, parentless tips and parents outside the page.
    const odd = [c('x', 'a', 'a'), c('t'), c('y', 'q', 'a'), c('z', 'a', 'q', 'r'), c('a')]
    expect(JSON.parse(JSON.stringify(computeGraphLayout(odd)))).toEqual(referenceLayout(odd))
  })

  it('shares one pass-through segment object per lane lifetime', () => {
    const commits = [c('x', 'a'), c('y1', 'y2'), c('y2', 'y3'), c('y3'), c('a')]
    const { rows } = computeGraphLayout(commits)
    // Lane 0 (x -> a) passes through rows 1..3 as one shared object.
    expect(rows[1]!.passThrough[0]).toEqual({ from: 0, to: 0, color: rows[0]!.color })
    expect(rows[1]!.passThrough[0]).toBe(rows[2]!.passThrough[0])
    expect(rows[1]!.passThrough[0]).toBe(rows[3]!.passThrough[0])
    expect(rows[0]!.outgoing[0]).toBe(rows[1]!.passThrough[0])
  })

  it('stays consistent on a real repository history', async () => {
    const repo = createFixtureRepo()
    repo.commit('root', { 'a.txt': '1' })
    for (let i = 0; i < 4; i++) {
      repo.branch(`f${i}`)
      repo.checkout(`f${i}`)
      repo.commit(`f${i} one`, { [`f${i}.txt`]: '1' })
      repo.commit(`f${i} two`, { [`f${i}.txt`]: '2' })
      repo.checkout('main')
      repo.commit(`main ${i}`, { 'a.txt': String(i) })
      if (i % 2 === 0) repo.merge(`f${i}`)
    }
    const { commits } = await getCommitPage(repo.dir, { skip: 0, limit: 1000 })
    const layout = computeGraphLayout(commits)
    assertConsistent(layout, commits)
    expect(layout.width).toBeGreaterThan(1)
    expect(layout.rows.filter((r) => r.isMerge)).toHaveLength(2)
  })
})

/** Deterministic random DAG in a valid child-before-parent order. */
function randomDag(n: number, seed: number): LayoutCommit[] {
  let s = seed
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  // Build oldest-first, then reverse so children precede parents.
  const out: LayoutCommit[] = []
  for (let i = 0; i < n; i++) {
    const parents: string[] = []
    if (i > 0 && rand() > 0.03) parents.push(`c${Math.max(0, i - 1 - Math.floor(rand() * 6))}`)
    if (i > 2 && rand() < 0.2) {
      const p = `c${Math.floor(rand() * (i - 1))}`
      if (!parents.includes(p)) parents.push(p)
    }
    out.push({ sha: `c${i}`, parents })
  }
  return out.reverse()
}

/** Verbatim copy of the original lane algorithm, used as an oracle for the optimised builder. */
function referenceLayout(commits: readonly LayoutCommit[]): GraphLayout {
  type Seg = { from: number; to: number; color: number }
  let lanes: ({ sha: string; color: number } | null)[] = []
  let nextColor = 0
  let width = 0
  const alloc = (): number => {
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    return lanes.length - 1
  }
  const find = (sha: string): number => lanes.findIndex((l) => l !== null && l.sha === sha)
  const rows = commits.map((commit) => {
    const incoming: Seg[] = []
    const passThrough: Seg[] = []
    const matching: number[] = []
    lanes.forEach((l, i) => {
      if (l && l.sha === commit.sha) matching.push(i)
    })
    let column: number
    let color: number
    if (matching.length > 0) {
      column = matching[0]!
      color = lanes[column]!.color
    } else {
      column = alloc()
      color = nextColor++
    }
    lanes.forEach((l, i) => {
      if (!l) return
      if (l.sha === commit.sha) incoming.push({ from: i, to: column, color: l.color })
      else passThrough.push({ from: i, to: i, color: l.color })
    })
    for (const i of matching) lanes[i] = null
    const outgoing: Seg[] = []
    commit.parents.forEach((parent, idx) => {
      const existing = find(parent)
      if (existing !== -1) {
        outgoing.push({ from: column, to: existing, color: idx === 0 ? color : lanes[existing]!.color })
        return
      }
      if (idx === 0) {
        lanes[column] = { sha: parent, color }
        outgoing.push({ from: column, to: column, color })
      } else {
        const lane = alloc()
        const laneColor = nextColor++
        lanes[lane] = { sha: parent, color: laneColor }
        outgoing.push({ from: column, to: lane, color: laneColor })
      }
    })
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    lanes = [...lanes]
    const used = Math.max(column + 1, lanes.length, ...incoming.map((s) => s.from + 1), ...passThrough.map((s) => s.from + 1))
    width = Math.max(width, used)
    return { sha: commit.sha, column, color, incoming, outgoing, passThrough, isMerge: commit.parents.length > 1 }
  })
  return { rows, width }
}

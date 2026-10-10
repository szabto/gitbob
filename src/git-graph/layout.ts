/**
 * Commit graph lane layout.
 *
 * Input: commits ordered so that every child precedes its parents (git log
 * --date-order / --topo-order). Output: for each row, the column of the
 * commit node and the line segments to draw in that row.
 *
 * Model: a row spans from its top edge (y=0) through the node (y=0.5) to its
 * bottom edge (y=1). `lanes` is the set of active columns between rows; each
 * active lane "expects" a specific commit sha further down.
 *   - pass-through: a lane unrelated to this row's commit, drawn top -> bottom.
 *   - incoming: a lane expecting this commit, drawn top(lane) -> node.
 *   - outgoing: one per parent, drawn node -> bottom(lane of that parent).
 * Lanes keep their column for their whole lifetime, so rows tile seamlessly.
 */

export interface LayoutCommit {
  sha: string
  parents: readonly string[]
}

export interface Segment {
  /** Column at the start of the segment (top of row, or node column). */
  from: number
  /** Column at the end of the segment (node column, or bottom of row). */
  to: number
  color: number
}

export interface GraphRow {
  sha: string
  column: number
  color: number
  /** Lines from the top edge into the node. */
  incoming: Segment[]
  /** Lines from the node to the bottom edge, one per parent. */
  outgoing: Segment[]
  /** Lines passing straight through this row (from === to). */
  passThrough: Segment[]
  isMerge: boolean
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Maximum number of columns used by any row (for sizing the graph area). */
  width: number
}

interface Lane {
  sha: string
  color: number
}

/** Incremental layout state so pages of history can be appended without recomputing. */
export class GraphLayoutBuilder {
  private lanes: (Lane | null)[] = []
  private nextColor = 0
  private readonly rows: GraphRow[] = []
  private width = 0

  /** Append commits (which must continue the ordering of previously added commits). */
  append(commits: readonly LayoutCommit[]): void {
    for (const c of commits) this.rows.push(this.place(c))
  }

  result(): GraphLayout {
    return { rows: this.rows, width: this.width }
  }

  private alloc(): number {
    const free = this.lanes.indexOf(null)
    if (free !== -1) return free
    this.lanes.push(null)
    return this.lanes.length - 1
  }

  private find(sha: string): number {
    return this.lanes.findIndex((l) => l !== null && l.sha === sha)
  }

  private place(commit: LayoutCommit): GraphRow {
    const incoming: Segment[] = []
    const passThrough: Segment[] = []

    // Lanes that expect this commit converge into its node.
    const matching: number[] = []
    this.lanes.forEach((l, i) => {
      if (l && l.sha === commit.sha) matching.push(i)
    })

    let column: number
    let color: number
    if (matching.length > 0) {
      column = matching[0]!
      color = this.lanes[column]!.color
    } else {
      // A branch tip not referenced by any child we've seen.
      column = this.alloc()
      color = this.nextColor++
    }

    this.lanes.forEach((l, i) => {
      if (!l) return
      if (l.sha === commit.sha) incoming.push({ from: i, to: column, color: l.color })
      else passThrough.push({ from: i, to: i, color: l.color })
    })
    for (const i of matching) this.lanes[i] = null

    const outgoing: Segment[] = []
    commit.parents.forEach((parent, idx) => {
      const existing = this.find(parent)
      if (existing !== -1) {
        // Parent is already expected by another lane: join it.
        outgoing.push({ from: column, to: existing, color: idx === 0 ? color : this.lanes[existing]!.color })
        return
      }
      if (idx === 0) {
        this.lanes[column] = { sha: parent, color }
        outgoing.push({ from: column, to: column, color })
      } else {
        const lane = this.alloc()
        const laneColor = this.nextColor++
        this.lanes[lane] = { sha: parent, color: laneColor }
        outgoing.push({ from: column, to: lane, color: laneColor })
      }
    })

    // Trim trailing empty lanes so the graph narrows again.
    while (this.lanes.length > 0 && this.lanes[this.lanes.length - 1] === null) this.lanes.pop()

    const used = Math.max(
      column + 1,
      this.lanes.length,
      ...incoming.map((s) => s.from + 1),
      ...passThrough.map((s) => s.from + 1),
    )
    this.width = Math.max(this.width, used)

    return { sha: commit.sha, column, color, incoming, outgoing, passThrough, isMerge: commit.parents.length > 1 }
  }
}

export function computeGraphLayout(commits: readonly LayoutCommit[]): GraphLayout {
  const b = new GraphLayoutBuilder()
  b.append(commits)
  return b.result()
}

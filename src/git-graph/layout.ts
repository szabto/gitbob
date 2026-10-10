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
 *
 * Performance notes (see docs/BENCHMARKS.md): a wide graph emits one
 * pass-through segment per active lane per row, millions for 100k commits.
 * A lane's pass-through segment never changes while the lane lives, so one
 * Segment object is shared by every row the lane passes through; segments
 * are therefore immutable. Lane lookup by sha is a Map instead of a scan.
 */

export interface LayoutCommit {
  sha: string
  parents: readonly string[]
}

/** Segments may be shared between rows; treat them as immutable. */
export interface Segment {
  /** Column at the start of the segment (top of row, or node column). */
  readonly from: number
  /** Column at the end of the segment (node column, or bottom of row). */
  readonly to: number
  readonly color: number
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
  /** The vertical segment {from: column, to: column} shared by every row this lane passes through. */
  straight: Segment
}

/** Incremental layout state so pages of history can be appended without recomputing. */
export class GraphLayoutBuilder {
  private lanes: (Lane | null)[] = []
  /** sha -> index of the lane expecting it. A sha is expected by at most one lane. */
  private readonly expected = new Map<string, number>()
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

  private open(index: number, sha: string, color: number): Lane {
    const lane: Lane = { sha, color, straight: { from: index, to: index, color } }
    this.lanes[index] = lane
    this.expected.set(sha, index)
    return lane
  }

  private place(commit: LayoutCommit): GraphRow {
    const lanes = this.lanes
    const startWidth = lanes.length

    // The lane (if any) expecting this commit converges into its node.
    const matched = this.expected.get(commit.sha)
    let column: number
    let color: number
    const incoming: Segment[] = []
    if (matched !== undefined) {
      column = matched
      color = lanes[matched]!.color
      incoming.push(lanes[matched]!.straight)
      lanes[matched] = null
      this.expected.delete(commit.sha)
    } else {
      // A branch tip not referenced by any child we've seen.
      column = this.alloc()
      color = this.nextColor++
    }

    const passThrough: Segment[] = []
    for (let i = 0; i < startWidth; i++) {
      const l = lanes[i]
      if (l) passThrough.push(l.straight)
    }

    const parents = commit.parents
    const outgoing: Segment[] = []
    for (let idx = 0; idx < parents.length; idx++) {
      const parent = parents[idx]!
      const existing = this.expected.get(parent)
      if (existing !== undefined) {
        // Parent is already expected by another lane: join it.
        outgoing.push({ from: column, to: existing, color: idx === 0 ? color : lanes[existing]!.color })
      } else if (idx === 0) {
        outgoing.push(this.open(column, parent, color).straight)
      } else {
        const lane = this.alloc()
        const laneColor = this.nextColor++
        this.open(lane, parent, laneColor)
        outgoing.push({ from: column, to: lane, color: laneColor })
      }
    }

    // Trim trailing empty lanes so the graph narrows again.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    // Trailing lanes are trimmed after every row, so the last lane entering
    // this row was occupied: startWidth is the widest incoming/pass-through
    // column + 1.
    const used = Math.max(column + 1, startWidth, lanes.length)
    if (used > this.width) this.width = used

    return { sha: commit.sha, column, color, incoming, outgoing, passThrough, isMerge: parents.length > 1 }
  }
}

export function computeGraphLayout(commits: readonly LayoutCommit[]): GraphLayout {
  const b = new GraphLayoutBuilder()
  b.append(commits)
  return b.result()
}

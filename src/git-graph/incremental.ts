import { GraphLayoutBuilder, type GraphLayout, type LayoutCommit } from './layout'

/**
 * Keeps a layout up to date as history pages arrive. When the commit list only
 * grew at the end, new commits are appended to the existing builder; any other
 * change (refresh, new commits at the top, different repository) rebuilds.
 * Calling `update` twice with the same list does no extra work.
 */
export class IncrementalLayout {
  private builder = new GraphLayoutBuilder()
  private count = 0
  private first: string | undefined
  private last: string | undefined

  update(commits: readonly LayoutCommit[]): GraphLayout {
    const extendsPrevious =
      commits.length >= this.count &&
      commits[0]?.sha === this.first &&
      (this.count === 0 || commits[this.count - 1]?.sha === this.last)
    if (!extendsPrevious || this.count === 0) {
      this.builder = new GraphLayoutBuilder()
      this.builder.append(commits)
    } else if (commits.length > this.count) {
      this.builder.append(commits.slice(this.count))
    }
    this.count = commits.length
    this.first = commits[0]?.sha
    this.last = commits.at(-1)?.sha
    const r = this.builder.result()
    // Fresh object so React consumers re-render; rows are shared with the builder.
    return { rows: r.rows, width: r.width }
  }
}

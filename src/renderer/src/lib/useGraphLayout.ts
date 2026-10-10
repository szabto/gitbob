import { useMemo, useState } from 'react'
import type { GraphLayout, LayoutCommit } from '@git-graph/layout'
import { IncrementalLayout } from '@git-graph/incremental'

/** Graph layout that appends new history pages instead of recomputing everything. */
export function useGraphLayout(commits: readonly LayoutCommit[]): GraphLayout {
  const [incremental] = useState(() => new IncrementalLayout())
  return useMemo(() => incremental.update(commits), [incremental, commits])
}

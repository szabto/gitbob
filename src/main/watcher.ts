import { watch, type FSWatcher } from 'node:fs'
import { relative, sep } from 'node:path'

/** Files inside .git whose changes affect what the UI shows (refs, index, HEAD, operation state). */
const RELEVANT_GIT_PATHS = [
  'HEAD',
  'index',
  'packed-refs',
  'refs',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'FETCH_HEAD',
]

export function isRelevantChange(root: string, gitDir: string, changedPath: string): boolean {
  const relToGit = relative(gitDir, changedPath)
  if (!relToGit.startsWith('..') && relToGit !== changedPath) {
    // Inside the git dir: only care about refs/index/HEAD/operation state; ignore objects, logs, locks.
    if (relToGit.endsWith('.lock')) return false
    const first = relToGit.split(sep)[0] ?? ''
    return RELEVANT_GIT_PATHS.includes(first)
  }
  const relToRoot = relative(root, changedPath)
  return !relToRoot.startsWith('..')
}

/**
 * Watches a repository's worktree and git dir and invokes `onChange` at most
 * once per `debounceMs` burst of relevant filesystem events.
 */
export class RepositoryWatcher {
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly root: string,
    private readonly gitDir: string,
    private readonly onChange: () => void,
    private readonly debounceMs = 300,
  ) {}

  start(): void {
    const dirs = this.gitDir.startsWith(this.root + sep) ? [this.root] : [this.root, this.gitDir]
    for (const dir of new Set(dirs)) {
      try {
        const w = watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return this.schedule()
          const full = `${dir}${sep}${filename.toString()}`
          if (isRelevantChange(this.root, this.gitDir, full)) this.schedule()
        })
        w.on('error', () => {
          /* the directory may have been removed; ignore */
        })
        this.watchers.push(w)
      } catch {
        // Recursive watching unavailable on this platform/filesystem; the UI still refreshes on focus.
      }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onChange()
    }, this.debounceMs)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    for (const w of this.watchers) w.close()
    this.watchers = []
  }
}

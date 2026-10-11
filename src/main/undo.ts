import { GitError } from '@git-core/errors'
import { applyUndoSteps, StaleUndoError, type UndoStep } from '@git-core/undo'

export interface UndoEntry {
  /** What the original action did, e.g. `Commit "Fix typo"`. */
  label: string
  undo: UndoStep[]
  redo: UndoStep[]
}

export interface UndoState {
  undo: string | null
  redo: string | null
}

const MAX_ENTRIES = 50

/**
 * Per-repository undo/redo history of actions GitBob performed in this session. Lives only in
 * the main process; the renderer can ask for labels and trigger undo/redo, never supply steps.
 */
export class UndoJournal {
  private stacks = new Map<string, { undo: UndoEntry[]; redo: UndoEntry[] }>()
  private running = new Set<string>()

  private stack(repoPath: string): { undo: UndoEntry[]; redo: UndoEntry[] } {
    let s = this.stacks.get(repoPath)
    if (!s) this.stacks.set(repoPath, (s = { undo: [], redo: [] }))
    return s
  }

  record(repoPath: string, entry: UndoEntry): void {
    const s = this.stack(repoPath)
    s.undo.push(entry)
    if (s.undo.length > MAX_ENTRIES) s.undo.shift()
    s.redo = []
  }

  state(repoPath: string): UndoState {
    const s = this.stacks.get(repoPath)
    return { undo: s?.undo.at(-1)?.label ?? null, redo: s?.redo.at(-1)?.label ?? null }
  }

  forget(repoPath: string): void {
    this.stacks.delete(repoPath)
  }

  async undo(repoPath: string): Promise<{ label: string }> {
    return this.move(repoPath, 'undo')
  }

  async redo(repoPath: string): Promise<{ label: string }> {
    return this.move(repoPath, 'redo')
  }

  private async move(repoPath: string, dir: 'undo' | 'redo'): Promise<{ label: string }> {
    if (this.running.has(repoPath)) throw new GitError('INVALID_ARGUMENT', 'An undo or redo is already running.')
    const s = this.stack(repoPath)
    const from = dir === 'undo' ? s.undo : s.redo
    const to = dir === 'undo' ? s.redo : s.undo
    const entry = from.at(-1)
    if (!entry) throw new GitError('INVALID_ARGUMENT', dir === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.')
    this.running.add(repoPath)
    try {
      await applyUndoSteps(repoPath, dir === 'undo' ? entry.undo : entry.redo)
    } catch (e) {
      // History older than a state that no longer matches can't be trusted either.
      if (e instanceof StaleUndoError) this.forget(repoPath)
      throw e
    } finally {
      this.running.delete(repoPath)
    }
    from.pop()
    to.push(entry)
    return { label: entry.label }
  }
}

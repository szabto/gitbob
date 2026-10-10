import { useMemo, useState } from 'react'
import type { ConflictVersions } from '@shared/types'
import { parseConflicts, resolveConflicts, type ConflictChoice } from '@shared/conflict-markers'
import { useQuery } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useRepoMutation } from '../lib/queries'
import { useAppStore } from '../state/store'
import { useUiStore } from '../state/ui'
import { MonacoEditor } from './MonacoEditor'

/** Three-way conflict resolution: ours and theirs on top, editable result below. */
export default function ConflictEditor({ repoPath, path }: { repoPath: string; path: string }) {
  const openConflict = useAppStore((s) => s.openConflict)
  const versions = useQuery({
    queryKey: ['conflict', repoPath, path],
    queryFn: () => call('conflict:get', { repoPath, path }),
    staleTime: Infinity,
    gcTime: 0,
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conflict-editor">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
        <span className="rounded bg-err/15 px-1.5 py-0.5 text-xs text-err">Conflict</span>
        <span className="truncate font-mono text-xs">{path}</span>
        <button
          className="ml-auto rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2"
          onClick={() => openConflict(null)}
        >
          Close
        </button>
      </div>
      {versions.isPending ? (
        <div className="p-4 text-xs text-muted">Loading…</div>
      ) : versions.isError ? (
        <div className="p-4 text-xs text-danger">{versions.error.message}</div>
      ) : versions.data.binary ? (
        <div className="p-4 text-sm text-muted">
          This is a binary file. Replace it with the version you want outside GitBob, then mark it resolved in Working
          changes.
        </div>
      ) : (
        <Resolver key={path} repoPath={repoPath} path={path} data={versions.data} onDone={() => openConflict(null)} />
      )}
    </div>
  )
}

function Resolver({
  repoPath,
  path,
  data,
  onDone,
}: {
  repoPath: string
  path: string
  data: ConflictVersions
  onDone: () => void
}) {
  const [result, setResult] = useState(data.merged)
  const showError = useUiStore((s) => s.showError)
  const segments = useMemo(() => parseConflicts(result), [result])
  const conflicts = segments.filter((s) => s.type === 'conflict')

  const save = useRepoMutation(
    repoPath,
    (markResolved: boolean) => call('conflict:save', { repoPath, path, content: result, markResolved }),
    { history: false },
  )

  const choose = (index: number, choice: ConflictChoice): void => {
    const choices: (ConflictChoice | null)[] = conflicts.map((_, i) => (i === index ? choice : null))
    setResult(resolveConflicts(segments, choices))
  }
  const chooseAll = (choice: ConflictChoice): void => setResult(resolveConflicts(segments, conflicts.map(() => choice)))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid h-[38%] min-h-32 shrink-0 grid-cols-2 border-b border-border">
        <Pane title={`Ours — ${data.oursLabel}`} testId="conflict-ours">
          <MonacoEditor path={path} value={data.ours ?? ''} readOnly />
        </Pane>
        <Pane title={`Theirs — ${data.theirsLabel}`} testId="conflict-theirs" border>
          <MonacoEditor path={path} value={data.theirs ?? ''} readOnly />
        </Pane>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-xs">
        <span className="font-semibold" data-testid="conflict-count">
          {conflicts.length === 0 ? 'All conflicts resolved' : `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} left`}
        </span>
        {conflicts.map((_, i) => (
          <span key={i} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5" data-testid="conflict-chunk">
            <span className="text-muted">#{i + 1}</span>
            <ChunkButton onClick={() => choose(i, 'ours')}>Ours</ChunkButton>
            <ChunkButton onClick={() => choose(i, 'theirs')}>Theirs</ChunkButton>
            <ChunkButton onClick={() => choose(i, 'both')}>Both</ChunkButton>
          </span>
        ))}
        {conflicts.length > 1 && (
          <>
            <ChunkButton onClick={() => chooseAll('ours')}>All ours</ChunkButton>
            <ChunkButton onClick={() => chooseAll('theirs')}>All theirs</ChunkButton>
          </>
        )}
        <span className="ml-auto flex gap-2">
          <button
            disabled={save.isPending}
            onClick={() => save.mutate(false, { onError: showError })}
            className="rounded border border-border px-2.5 py-0.5 hover:bg-panel-2 disabled:opacity-40"
          >
            Save
          </button>
          <button
            disabled={save.isPending || conflicts.length > 0}
            title={conflicts.length > 0 ? 'Resolve every conflict first' : undefined}
            onClick={() => save.mutate(true, { onError: showError, onSuccess: onDone })}
            className="rounded bg-gradient-to-r from-accent to-accent-2 px-2.5 py-0.5 font-medium text-on-accent disabled:opacity-40"
          >
            Save and mark resolved
          </button>
        </span>
      </div>
      <Pane title="Result (editable)" testId="conflict-result" grow>
        <MonacoEditor path={path} value={result} onChange={setResult} />
      </Pane>
    </div>
  )
}

function Pane({
  title,
  children,
  testId,
  border,
  grow,
}: {
  title: string
  children: React.ReactNode
  testId: string
  border?: boolean
  grow?: boolean
}) {
  return (
    <div className={`flex min-h-0 flex-col ${border ? 'border-l border-border' : ''} ${grow ? 'flex-1' : ''}`} data-testid={testId}>
      <div className="shrink-0 truncate bg-panel-2 px-3 py-0.5 text-[11px] font-semibold text-muted">{title}</div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

function ChunkButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded px-1 text-accent hover:bg-accent/15">
      {children}
    </button>
  )
}

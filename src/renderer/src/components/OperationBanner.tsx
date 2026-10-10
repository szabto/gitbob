import type { WorkingTreeStatus } from '@shared/types'
import type { useRepoActions } from '../lib/actions'

const labels: Record<NonNullable<WorkingTreeStatus['operation']>, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  bisect: 'Bisect',
}

/** Shown while a merge/rebase/cherry-pick/revert is stopped, with the ways out. */
export function OperationBanner({
  status,
  actions,
}: {
  status: WorkingTreeStatus
  actions: ReturnType<typeof useRepoActions>
}) {
  if (!status.operation) return null
  const conflicts = status.entries.filter((e) => e.kind === 'unmerged').length
  const canSkip = status.operation === 'rebase' || status.operation === 'cherry-pick' || status.operation === 'revert'
  return (
    <div
      role="status"
      data-testid="operation-banner"
      className="flex items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-sm"
    >
      <span className="font-semibold text-warn">{labels[status.operation]} in progress</span>
      <span className="text-muted">
        {conflicts > 0
          ? `${conflicts} conflicted file${conflicts === 1 ? '' : 's'}. Open Working changes and click a conflicted file to resolve it.`
          : 'No conflicts left. Continue to finish.'}
      </span>
      {status.operation !== 'bisect' && (
        <div className="ml-auto flex gap-2">
          <button
            disabled={conflicts > 0}
            onClick={() => void actions.continueOperation()}
            className="rounded bg-accent px-2.5 py-0.5 font-medium text-[#0b1220] disabled:opacity-40"
          >
            Continue
          </button>
          {canSkip && (
            <button onClick={() => void actions.skipOperation()} className="rounded border border-border px-2.5 py-0.5 hover:bg-panel-2">
              Skip
            </button>
          )}
          <button onClick={() => void actions.abortOperation()} className="rounded border border-border px-2.5 py-0.5 text-err hover:bg-err/10">
            Abort…
          </button>
        </div>
      )}
    </div>
  )
}

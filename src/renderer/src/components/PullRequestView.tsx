import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MergeMethod, PullRequestDetail, ReviewEvent } from '@shared/types'
import { call } from '../lib/api'
import { useChecks } from '../lib/queries'
import { formatDate } from '../lib/format'
import { useAppStore } from '../state/store'
import { useUiStore } from '../state/ui'

const isWeb = (u: string | undefined | null): u is string => !!u && /^https?:\/\//i.test(u)

/** A pull request inside GitBob: conversation, changed files, review and merge. */
export function PullRequestView({ repoPath, number, providerName }: { repoPath: string; number: number; providerName: string }) {
  const openPr = useAppStore((s) => s.openPr)
  const [tab, setTab] = useState<'conversation' | 'files'>('conversation')
  const pr = useQuery({ queryKey: ['pr', repoPath, number], queryFn: () => call('provider:pr', { repoPath, number }) })
  const checks = useChecks(repoPath, pr.data?.headSha ?? '', !!pr.data?.headSha && /^[0-9a-f]{7,64}$/i.test(pr.data.headSha))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pr-view">
      <div className="flex min-h-9 shrink-0 items-center gap-3 border-b border-border bg-panel px-3 py-1">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted">Pull request #{number}</span>
        <span className="min-w-0 flex-1 truncate font-semibold" data-testid="pr-title">
          {pr.data?.title ?? '…'}
        </span>
        {isWeb(pr.data?.url) && (
          <button className="rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2" onClick={() => window.open(pr.data!.url, '_blank')}>
            Open on {providerName}
          </button>
        )}
        <button className="rounded border border-border px-2 py-0.5 text-xs hover:bg-panel-2" onClick={() => openPr(null)}>
          Close
        </button>
      </div>
      {pr.isPending ? (
        <div className="p-4 text-xs text-muted">Loading…</div>
      ) : pr.isError ? (
        <div className="p-4 text-sm text-err">{pr.error.message}</div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted">
            <StateBadge pr={pr.data} />
            <span>
              <strong className="text-fg">{pr.data.author}</strong> wants to merge{' '}
              <code className="text-fg">{pr.data.sourceBranch}</code> into <code className="text-fg">{pr.data.targetBranch}</code>
            </span>
            {pr.data.changedFiles !== null && (
              <span>
                {pr.data.changedFiles} files{pr.data.additions !== null ? ` · +${pr.data.additions} −${pr.data.deletions}` : ''}
              </span>
            )}
            {checks.data && checks.data.state !== 'none' && (
              <span data-testid="pr-ci" className={checks.data.state === 'success' ? 'text-ok' : checks.data.state === 'failure' ? 'text-err' : 'text-warn'}>
                CI: {checks.data.state === 'success' ? 'passing' : checks.data.state === 'failure' ? `${checks.data.failed} failing` : 'running'}
              </span>
            )}
          </div>
          <div className="flex shrink-0 gap-1 border-b border-border px-3" role="tablist">
            {(['conversation', 'files'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`border-b-2 px-3 py-1.5 text-sm ${tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}
              >
                {t === 'conversation' ? 'Conversation' : 'Files'}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'conversation' ? <Conversation repoPath={repoPath} pr={pr.data} /> : <Files repoPath={repoPath} number={number} />}
          </div>
        </>
      )}
    </div>
  )
}

function StateBadge({ pr }: { pr: PullRequestDetail }) {
  const label = pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : pr.draft ? 'Draft' : 'Open'
  const cls = pr.state === 'merged' ? 'bg-purple/20 text-purple' : pr.state === 'closed' ? 'bg-err/15 text-err' : pr.draft ? 'bg-muted/20 text-muted' : 'bg-ok/15 text-ok'
  return <span className={`rounded-full px-2 py-0.5 font-semibold ${cls}`} data-testid="pr-state">{label}</span>
}

function Conversation({ repoPath, pr }: { repoPath: string; pr: PullRequestDetail }) {
  const qc = useQueryClient()
  const comments = useQuery({ queryKey: ['pr-comments', repoPath, pr.number], queryFn: () => call('provider:pr-comments', { repoPath, number: pr.number }) })
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const { showError, showNotice } = useUiStore.getState()
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['pr', repoPath, pr.number] })
    void qc.invalidateQueries({ queryKey: ['pr-comments', repoPath, pr.number] })
    void qc.invalidateQueries({ queryKey: ['pulls', repoPath] })
  }
  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      setText('')
      showNotice(done)
      refresh()
    } catch (e) {
      showError(e)
    } finally {
      setBusy(false)
    }
  }
  const review = (event: ReviewEvent): Promise<void> =>
    act(
      () => call('provider:pr-review', { repoPath, number: pr.number, event, body: text }),
      event === 'approve' ? 'Approved.' : event === 'request-changes' ? 'Changes requested.' : 'Review comment posted.',
    )

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="rounded-md border border-border bg-panel p-3">
        <div className="mb-1 text-xs text-muted">Description</div>
        <div className="selectable text-sm whitespace-pre-wrap" data-testid="pr-body">
          {pr.body.trim() || <span className="text-muted">No description.</span>}
        </div>
      </div>
      {pr.reviewers.length > 0 && (
        <div className="text-xs" data-testid="pr-reviewers">
          <span className="text-muted">Reviewers: </span>
          {pr.reviewers.map((r) => (
            <span key={r.login} className="mr-3">
              {r.login}{' '}
              <span className={r.state === 'approved' ? 'text-ok' : r.state === 'changes-requested' ? 'text-err' : 'text-muted'}>
                ({r.state.replace('-', ' ')})
              </span>
            </span>
          ))}
        </div>
      )}
      <ul className="space-y-2" data-testid="pr-comments">
        {comments.isPending && <li className="text-xs text-muted">Loading comments…</li>}
        {comments.data?.map((c) => (
          <li key={c.id} className="rounded-md border border-border p-2">
            <div className="mb-1 text-xs text-muted">
              <strong className="text-fg">{c.author}</strong> · {formatDate(Date.parse(c.createdAt) / 1000)}
              {c.path && <span className="ml-2 font-mono">{c.path}{c.line ? `:${c.line}` : ''}</span>}
            </div>
            <div className="selectable text-sm whitespace-pre-wrap">{c.body}</div>
          </li>
        ))}
      </ul>
      {pr.state === 'open' && (
        <div className="rounded-md border border-border p-3" data-testid="pr-review-box">
          <label htmlFor="pr-comment" className="mb-1 block text-xs text-muted">
            Comment or review
          </label>
          <textarea
            id="pr-comment"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full resize-y rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={busy || !text.trim()} onClick={() => void act(() => call('provider:pr-comment', { repoPath, number: pr.number, body: text }), 'Comment posted.')} className="rounded border border-border px-2.5 py-1 text-sm hover:bg-panel-2 disabled:opacity-40">
              Comment
            </button>
            <span className="ml-auto" />
            <button disabled={busy || !text.trim()} onClick={() => void review('request-changes')} className="rounded border border-border px-2.5 py-1 text-sm text-err hover:bg-err/10 disabled:opacity-40">
              Request changes
            </button>
            <button disabled={busy} onClick={() => void review('approve')} className="rounded bg-ok/20 px-2.5 py-1 text-sm font-medium text-ok hover:bg-ok/30 disabled:opacity-40">
              Approve
            </button>
          </div>
        </div>
      )}
      {pr.state === 'open' && <MergePanel repoPath={repoPath} pr={pr} onMerged={refresh} />}
    </div>
  )
}

function MergePanel({ repoPath, pr, onMerged }: { repoPath: string; pr: PullRequestDetail; onMerged: () => void }) {
  const [method, setMethod] = useState<MergeMethod>(pr.mergeMethods[0] ?? 'merge')
  const [deleteBranch, setDeleteBranch] = useState(!pr.headRepoIsFork)
  const [busy, setBusy] = useState(false)
  const { showError, showNotice } = useUiStore.getState()
  const blocked = pr.mergeable === 'conflicts' || pr.mergeable === 'no' || pr.draft
  const labels: Record<MergeMethod, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' }
  return (
    <div className="rounded-md border border-border p-3" data-testid="pr-merge">
      <div className="mb-2 text-sm">
        {pr.mergeable === 'conflicts' ? (
          <span className="text-err">This branch has conflicts that must be resolved first.</span>
        ) : pr.draft ? (
          <span className="text-muted">Draft pull requests can’t be merged.</span>
        ) : pr.mergeable === 'no' ? (
          <span className="text-warn">Merging is blocked (required reviews or checks).</span>
        ) : pr.mergeable === 'yes' ? (
          <span className="text-ok">No conflicts with the target branch.</span>
        ) : (
          <span className="text-muted">Mergeability is still being checked by {`the hosting service`}.</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Merge method" value={method} onChange={(e) => setMethod(e.target.value as MergeMethod)} className="rounded border border-border bg-bg px-2 py-1 text-sm">
          {pr.mergeMethods.map((m) => (
            <option key={m} value={m}>
              {labels[m]}
            </option>
          ))}
        </select>
        {!pr.headRepoIsFork && (
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
            Delete {pr.sourceBranch} after merging
          </label>
        )}
        <button
          disabled={busy || blocked}
          onClick={async () => {
            setBusy(true)
            try {
              const res = await call('provider:pr-merge', {
                repoPath,
                number: pr.number,
                method,
                deleteSourceBranch: deleteBranch,
                ...(pr.headSha && /^[0-9a-f]{4,64}$/i.test(pr.headSha) ? { expectedHeadSha: pr.headSha } : {}),
              })
              if (res.done) {
                showNotice(res.merged ? `Pull request #${pr.number} merged.` : res.message || 'Merge started.')
                onMerged()
              }
            } catch (e) {
              showError(e)
            } finally {
              setBusy(false)
            }
          }}
          className="ml-auto rounded bg-gradient-to-r from-accent to-accent-2 px-3 py-1 text-sm font-medium text-on-accent disabled:opacity-40"
        >
          {busy ? 'Merging…' : 'Merge pull request'}
        </button>
      </div>
    </div>
  )
}

function Files({ repoPath, number }: { repoPath: string; number: number }) {
  const showDiff = useAppStore((s) => s.showDiff)
  const changes = useQuery({
    queryKey: ['pr-changes', repoPath, number],
    queryFn: () => call('provider:pr-changes', { repoPath, number }),
    staleTime: 60_000,
  })
  if (changes.isPending) return <div className="p-4 text-xs text-muted">Fetching the pull request’s commits…</div>
  if (changes.isError) return <div className="p-4 text-sm text-err">{changes.error.message}</div>
  return (
    <ul className="p-2 font-mono text-xs" data-testid="pr-files">
      {changes.data.files.length === 0 && <li className="p-2 text-muted">No changed files.</li>}
      {changes.data.files.map((f) => (
        <li key={`${f.oldPath ?? ''}:${f.path}`}>
          <button
            data-testid="pr-file"
            onClick={() =>
              showDiff({ kind: 'range', base: changes.data.base, head: changes.data.head, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}) })
            }
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel-2"
          >
            <span className="w-3 font-bold">{f.status}</span>
            <span className="min-w-0 flex-1 truncate">{f.oldPath ? `${f.oldPath} → ` : ''}{f.path}</span>
            {f.additions !== null && (
              <span>
                <span className="text-ok">+{f.additions}</span> <span className="text-err">−{f.deletions}</span>
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

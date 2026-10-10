import type { FileChange, GitRef } from '@shared/types'
import { useCommitDetails } from '../lib/queries'
import { useQuery } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useAppStore } from '../state/store'
import { formatDate, shortSha } from '../lib/format'
import { RefBadge } from './RefBadge'

const statusLabel: Record<FileChange['status'], { label: string; cls: string }> = {
  A: { label: 'A', cls: 'text-ok' },
  M: { label: 'M', cls: 'text-warn' },
  D: { label: 'D', cls: 'text-err' },
  R: { label: 'R', cls: 'text-info' },
  C: { label: 'C', cls: 'text-info' },
  T: { label: 'T', cls: 'text-purple' },
  U: { label: 'U', cls: 'text-err' },
  X: { label: '?', cls: 'text-muted' },
}

export function CommitDetailsPanel({
  repoPath,
  sha,
  refsBySha,
}: {
  repoPath: string
  sha: string
  refsBySha: Map<string, GitRef[]>
}) {
  const details = useCommitDetails(repoPath, sha)
  const signature = useQuery({
    queryKey: ['signature', repoPath, sha],
    queryFn: () => call('commit:signature', { repoPath, sha }),
    staleTime: Infinity,
  })
  const reveal = useAppStore((s) => s.reveal)
  const select = useAppStore((s) => s.select)
  const showDiff = useAppStore((s) => s.showDiff)
  const diffTarget = useAppStore((s) => s.diffTarget)

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-panel" data-testid="commit-details">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-3 text-xs font-semibold text-muted">
        <span>Commit</span>
        <button onClick={() => select(null)} aria-label="Close details" className="hover:text-fg">
          ✕
        </button>
      </div>
      {details.isPending ? (
        <div className="p-4 text-muted">Loading…</div>
      ) : details.isError ? (
        <div className="p-4 text-danger">{details.error.message}</div>
      ) : (
        <div className="selectable min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-2 flex flex-wrap gap-1">
            {refsBySha.get(details.data.sha)?.map((r) => <RefBadge key={r.name} gitRef={r} current={false} />)}
          </div>
          <h2 className="text-[15px] font-semibold break-words" data-testid="details-subject">
            {details.data.subject}
          </h2>
          {details.data.body && (
            <pre className="mt-2 font-sans text-[13px] whitespace-pre-wrap text-fg/85" data-testid="details-body">
              {details.data.body}
            </pre>
          )}

          <dl className="mt-4 grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 text-xs">
            <dt className="text-muted">SHA</dt>
            <dd className="font-mono break-all" data-testid="details-sha">
              {details.data.sha}
            </dd>
            <dt className="text-muted">Author</dt>
            <dd>
              {details.data.authorName} &lt;{details.data.authorEmail}&gt;
              <div className="text-muted">{formatDate(details.data.authorTime)}</div>
            </dd>
            {(details.data.committerEmail !== details.data.authorEmail ||
              details.data.commitTime !== details.data.authorTime) && (
              <>
                <dt className="text-muted">Committer</dt>
                <dd>
                  {details.data.committerName} &lt;{details.data.committerEmail}&gt;
                  <div className="text-muted">{formatDate(details.data.commitTime)}</div>
                </dd>
              </>
            )}
            {signature.data && signature.data.status !== 'none' && (
              <>
                <dt className="text-muted">Signature</dt>
                <dd data-testid="signature" className={signature.data.status === 'good' ? 'text-ok' : 'text-warn'}>
                  {signature.data.status === 'good' ? '✓ Verified' : `⚠ ${signature.data.status.replace(/-/g, ' ')}`}
                  {signature.data.signer ? ` · ${signature.data.signer}` : ''}
                </dd>
              </>
            )}
            <dt className="text-muted">Parents</dt>
            <dd className="flex flex-wrap gap-1 font-mono">
              {details.data.parents.length === 0 && <span className="text-muted">none (root commit)</span>}
              {details.data.parents.map((p) => (
                <button key={p} className="text-accent hover:underline" onClick={() => reveal(p)}>
                  {shortSha(p)}
                </button>
              ))}
            </dd>
          </dl>

          <h3 className="mt-5 mb-1 text-xs font-semibold tracking-wider text-muted uppercase">
            {details.data.files.length} file{details.data.files.length === 1 ? '' : 's'} changed
            {details.data.parents.length > 1 && ' (vs first parent)'}
          </h3>
          <ul data-testid="details-files" className="font-mono text-xs">
            {details.data.files.map((f) => (
              <li
                key={`${f.status}:${f.oldPath ?? ''}:${f.path}`}
                data-testid="details-file"
                data-path={f.path}
                onClick={() =>
                  showDiff({ kind: 'commit', sha: details.data.sha, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}) })
                }
                className={`-mx-1 flex cursor-default items-center gap-2 rounded px-1 py-0.5 ${
                  diffTarget?.kind === 'commit' && diffTarget.sha === details.data.sha && diffTarget.path === f.path
                    ? 'bg-accent/20'
                    : 'hover:bg-fg/[0.05]'
                }`}
              >
                <span className={`w-3 shrink-0 font-bold ${statusLabel[f.status].cls}`}>{statusLabel[f.status].label}</span>
                <span className="min-w-0 flex-1 truncate" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  {f.oldPath ? `${f.oldPath} → ` : ''}
                  {f.path}
                </span>
                {f.additions === null ? (
                  <span className="text-muted">bin</span>
                ) : (
                  <span className="shrink-0">
                    <span className="text-ok">+{f.additions}</span>{' '}
                    <span className="text-err">-{f.deletions}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}

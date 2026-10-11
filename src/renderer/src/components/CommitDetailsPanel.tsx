import type { GitRef } from '@shared/types'
import { useChecks, useCommitDetails, useHead, useProviderStatus, useRemotes, useStatus } from '../lib/queries'
import { useQuery } from '@tanstack/react-query'
import { call } from '../lib/api'
import { useAppStore } from '../state/store'
import { formatDate, shortSha } from '../lib/format'
import { RefLabelPill } from './RefLabelPill'
import { Avatar } from './Avatar'
import { CommitFiles } from './CommitFiles'
import { buildRefLabels } from '../lib/ref-labels'
import { useAvatarSource } from '../lib/avatars'
import { useMemo } from 'react'

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
  const provider = useProviderStatus(repoPath)
  const checks = useChecks(repoPath, sha, !!provider.data?.connected)
  const signature = useQuery({
    queryKey: ['signature', repoPath, sha],
    queryFn: () => call('commit:signature', { repoPath, sha }),
    staleTime: Infinity,
  })
  const reveal = useAppStore((s) => s.reveal)
  const select = useAppStore((s) => s.select)
  const selectWip = useAppStore((s) => s.selectWip)
  const status = useStatus(repoPath)
  const remotes = useRemotes(repoPath)
  const avatarSource = useAvatarSource(repoPath)
  const head = useHead(repoPath)
  const labels = useMemo(() => buildRefLabels([...refsBySha.values()].flat(), head.data?.ref ?? null), [refsBySha, head.data?.ref])
  const changes = (status.data?.entries ?? []).filter((e) => e.kind !== 'ignored').length

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-panel" data-testid="commit-details">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-3 text-xs font-semibold text-muted">
        <span>Commit</span>
        <button onClick={() => select(null)} aria-label="Close details" className="hover:text-fg">
          ✕
        </button>
      </div>
      {changes > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-info/10 px-3 py-1.5 text-xs" data-testid="wip-banner">
          <span>
            {changes} file change{changes === 1 ? '' : 's'} in the working directory
          </span>
          <button className="ml-auto rounded border border-border px-2 py-0.5 hover:bg-panel-2" onClick={selectWip}>
            View changes
          </button>
        </div>
      )}
      {details.isPending ? (
        <div className="p-4 text-muted">Loading…</div>
      ) : details.isError ? (
        <div className="p-4 text-danger">{details.error.message}</div>
      ) : (
        <div className="selectable min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-2 flex flex-wrap gap-1">
            {labels.get(details.data.sha)?.map((l) => <RefLabelPill key={l.key} label={l} remotes={remotes.data ?? []} />)}
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
            <dd className="flex items-start gap-2">
              <Avatar name={details.data.authorName} email={details.data.authorEmail} source={avatarSource} size={28} />
              <div className="min-w-0">
                {details.data.authorName} &lt;{details.data.authorEmail}&gt;
                <div className="text-muted">authored {formatDate(details.data.authorTime)}</div>
              </div>
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
            {checks.data && checks.data.state !== 'none' && (
              <>
                <dt className="text-muted">CI</dt>
                <dd data-testid="ci-status">
                  <a
                    {...(isWebUrl(checks.data.url) ? { href: checks.data.url, target: '_blank', rel: 'noreferrer' } : {})}
                    className={
                      checks.data.state === 'success' ? 'text-ok' : checks.data.state === 'failure' ? 'text-err' : 'text-warn'
                    }
                  >
                    {checks.data.state === 'success'
                      ? `✓ ${checks.data.total} check${checks.data.total === 1 ? '' : 's'} passed`
                      : checks.data.state === 'failure'
                        ? `✗ ${checks.data.failed} of ${checks.data.total} failed`
                        : `● ${checks.data.pending} of ${checks.data.total} running`}
                  </a>
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

          <CommitFiles repoPath={repoPath} sha={details.data.sha} files={details.data.files} isMerge={details.data.parents.length > 1} />
        </div>
      )}
    </aside>
  )
}

/** Only http(s) links from providers are clickable (defense in depth; adapters sanitize too). */
function isWebUrl(u: string | undefined): u is string {
  return !!u && /^https?:\/\//i.test(u)
}

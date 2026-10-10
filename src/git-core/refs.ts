import type { GitRef, HeadState, RefKind } from '@shared/types'
import { runGit } from './runner'

const REF_FORMAT = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream)', '%(symref)', '%(upstream:track,nobracket)'].join(
  '%00',
)

/** Parse `git for-each-ref` output produced with REF_FORMAT. Symbolic refs (e.g. origin/HEAD) are skipped. */
export function parseRefs(stdout: string): GitRef[] {
  const refs: GitRef[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [name = '', object = '', peeled = '', upstream = '', symref = '', track = ''] = line.split('\0')
    if (!name || symref) continue
    const { kind, shortName } = classifyRef(name)
    refs.push({
      name,
      shortName,
      kind,
      target: peeled || object,
      ...(upstream ? { upstream, ...parseTrack(track) } : {}),
    })
  }
  return refs
}

/** Parse `%(upstream:track,nobracket)`: "ahead 1, behind 2", "gone" or "". */
export function parseTrack(track: string): { ahead: number; behind: number; upstreamGone?: true } {
  if (track === 'gone') return { ahead: 0, behind: 0, upstreamGone: true }
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 }
}

export function classifyRef(name: string): { kind: RefKind; shortName: string } {
  if (name.startsWith('refs/heads/')) return { kind: 'head', shortName: name.slice('refs/heads/'.length) }
  if (name.startsWith('refs/remotes/')) return { kind: 'remote', shortName: name.slice('refs/remotes/'.length) }
  if (name.startsWith('refs/tags/')) return { kind: 'tag', shortName: name.slice('refs/tags/'.length) }
  if (name === 'refs/stash') return { kind: 'stash', shortName: 'stash' }
  return { kind: 'other', shortName: name.replace(/^refs\//, '') }
}

export async function listRefs(repoPath: string): Promise<GitRef[]> {
  const { stdout } = await runGit(
    ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash'],
    { cwd: repoPath },
  )
  return parseRefs(stdout)
}

export async function getHead(repoPath: string): Promise<HeadState> {
  const [sym, rev] = await Promise.all([
    runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: repoPath, okExitCodes: [0, 1] }),
    runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: repoPath, okExitCodes: [0, 1] }),
  ])
  const ref = sym.exitCode === 0 ? sym.stdout.trim() : null
  const sha = rev.exitCode === 0 ? rev.stdout.trim() : null
  return { sha, ref, detached: ref === null, unborn: sha === null }
}

import type { ProviderKind, RepoRef } from './types'

/** A self-hosted instance the user registered (GitHub Enterprise Server, self-managed GitLab). */
export interface SelfHostedProvider {
  /** Host, optionally with port (`git.example.com`, `gitlab.local:8443`). A URL is accepted too. */
  host: string
  kind: ProviderKind
}

interface SplitUrl {
  /** 'http' | 'https' | 'ssh' | 'git' */
  scheme: string
  hostname: string
  port: string
  segments: string[]
}

const URL_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'])
const NAME_RE = /^[A-Za-z0-9_.-]+$/
const GITLAB_SEGMENT_RE = /^[A-Za-z0-9_.+-]+$/
const AZURE_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

function toSegments(path: string, decode: boolean): string[] | null {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!trimmed) return null
  const out: string[] = []
  for (const raw of trimmed.split('/')) {
    let seg = raw
    if (decode) {
      try {
        seg = decodeURIComponent(raw)
      } catch {
        return null
      }
    }
    // eslint-disable-next-line no-control-regex
    if (!seg || seg === '.' || seg === '..' || /[\0-\x1f/\\]/.test(seg)) return null
    out.push(seg)
  }
  const last = out.length - 1
  out[last] = out[last]!.replace(/\.git$/i, '')
  if (!out[last]) return null
  return out
}

function splitUrl(input: string): SplitUrl | null {
  const url = input.trim()
  if (!url || /[\s\0]/.test(url)) return null
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase()
    if (!URL_SCHEMES.has(scheme)) return null
    // WHATWG URL parsing silently resolves dot segments; refuse them instead.
    if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(url.slice(schemeMatch[0].length))) return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    const hostname = parsed.hostname.toLowerCase()
    if (!hostname) return null
    const segments = toSegments(parsed.pathname, true)
    if (!segments) return null
    const normalized = scheme === 'git+ssh' || scheme === 'ssh+git' ? 'ssh' : scheme
    // Username/password in the URL are deliberately dropped here.
    return { scheme: normalized, hostname, port: parsed.port, segments }
  }
  // scp-like syntax: [user@]host:path
  const scp = /^(?:[^@/]+@)?([A-Za-z0-9.-]+):(.+)$/.exec(url)
  if (!scp) return null
  const hostname = scp[1]!.toLowerCase()
  // A single letter is a Windows drive (C:\repo), not a host.
  if (hostname.length < 2) return null
  const segments = toSegments(scp[2]!, false)
  if (!segments) return null
  return { scheme: 'ssh', hostname, port: '', segments }
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
}

function webBase(u: SplitUrl, hostWithPort: string): string {
  return `${u.scheme === 'http' ? 'http' : 'https'}://${hostWithPort}`
}

function encodePath(segments: string[]): string {
  return segments.map(encodeURIComponent).join('/')
}

function github(u: SplitUrl, host: string): RepoRef | null {
  if (u.segments.length !== 2) return null
  const [owner, repo] = u.segments as [string, string]
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null
  return { kind: 'github', host, owner, repo, webUrl: `${webBase(u, host)}/${encodePath([owner, repo])}` }
}

function gitlab(u: SplitUrl, host: string): RepoRef | null {
  let segs = u.segments
  const dash = segs.indexOf('-')
  if (dash >= 0) segs = segs.slice(0, dash)
  if (segs.length < 2 || !segs.every((s) => GITLAB_SEGMENT_RE.test(s))) return null
  const repo = segs[segs.length - 1]!
  const owner = segs.slice(0, -1).join('/')
  return { kind: 'gitlab', host, owner, repo, webUrl: `${webBase(u, host)}/${encodePath(segs)}` }
}

function bitbucket(u: SplitUrl): RepoRef | null {
  if (u.segments.length !== 2) return null
  const [owner, repo] = u.segments as [string, string]
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null
  return {
    kind: 'bitbucket',
    host: 'bitbucket.org',
    owner,
    repo,
    webUrl: `https://bitbucket.org/${encodePath([owner, repo])}`,
  }
}

function azure(org: string, project: string, repo: string): RepoRef | null {
  if (!AZURE_ORG_RE.test(org) || !project || !repo) return null
  return {
    kind: 'azure',
    host: 'dev.azure.com',
    owner: org,
    project,
    repo,
    webUrl: `https://dev.azure.com/${encodePath([org, project])}/_git/${encodeURIComponent(repo)}`,
  }
}

/** `[project, '_git', repo]` or `['_git', repo]` (project named like the repository). */
function azureProjectRepo(segs: string[]): { project: string; repo: string } | null {
  if (segs.length === 3 && segs[1] === '_git') return { project: segs[0]!, repo: segs[2]! }
  if (segs.length === 2 && segs[0] === '_git') return { project: segs[1]!, repo: segs[1]! }
  return null
}

function azureFromUrl(u: SplitUrl): RepoRef | null {
  const h = u.hostname
  // ssh: git@ssh.dev.azure.com:v3/org/project/repo, org@vs-ssh.visualstudio.com:v3/org/project/repo
  if (h === 'ssh.dev.azure.com' || h === 'vs-ssh.visualstudio.com') {
    const s = u.segments
    if (s.length !== 4 || s[0] !== 'v3') return null
    return azure(s[1]!, s[2]!, s[3]!)
  }
  if (u.scheme !== 'https' && u.scheme !== 'http') return null
  if (h === 'dev.azure.com') {
    const [org, ...rest] = u.segments
    const pr = azureProjectRepo(rest)
    return org && pr ? azure(org, pr.project, pr.repo) : null
  }
  const legacy = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/.exec(h)
  if (legacy) {
    let segs = u.segments
    if (segs[0]?.toLowerCase() === 'defaultcollection') segs = segs.slice(1)
    const pr = azureProjectRepo(segs)
    return pr ? azure(legacy[1]!, pr.project, pr.repo) : null
  }
  return null
}

/**
 * Recognise a Git remote URL (https, ssh://, scp-like `git@host:path`) as a repository on a
 * supported hosting provider. Returns null for anything unrecognised. Credentials embedded in
 * the URL are never carried into the result.
 *
 * `selfHosted` registers GitHub Enterprise Server / self-managed GitLab hosts. Self-hosted
 * Bitbucket (Data Center) and Azure DevOps Server use different APIs and are not supported.
 */
export function parseRemoteUrl(url: string, selfHosted: SelfHostedProvider[] = []): RepoRef | null {
  const u = splitUrl(url)
  if (!u) return null
  const h = u.hostname
  const hostWithPort = u.port && (u.scheme === 'https' || u.scheme === 'http') ? `${h}:${u.port}` : h

  if (h === 'github.com' || h === 'www.github.com' || h === 'ssh.github.com') return github(u, 'github.com')
  if (h === 'gitlab.com' || h === 'www.gitlab.com' || h === 'altssh.gitlab.com') return gitlab(u, 'gitlab.com')
  if (h === 'bitbucket.org' || h === 'www.bitbucket.org' || h === 'altssh.bitbucket.org') return bitbucket(u)
  if (h === 'dev.azure.com' || h === 'ssh.dev.azure.com' || h.endsWith('.visualstudio.com')) return azureFromUrl(u)

  for (const entry of selfHosted) {
    const entryHost = normalizeHost(entry.host)
    if (!entryHost) continue
    const entryHostname = entryHost.replace(/:\d+$/, '')
    const matches = entryHost === hostWithPort || entryHostname === h
    if (!matches) continue
    // For ssh remotes the port is the ssh port; the web host is what the user registered.
    const webHost = u.scheme === 'https' || u.scheme === 'http' ? hostWithPort : entryHost
    if (entry.kind === 'github') return github(u, webHost)
    if (entry.kind === 'gitlab') return gitlab(u, webHost)
  }
  return null
}

/** The default REST API base URL for a repository's provider (GitHub Enterprise: /api/v3). */
export function defaultApiBaseUrl(ref: RepoRef): string {
  const origin = new URL(ref.webUrl).origin
  switch (ref.kind) {
    case 'github':
      return ref.host === 'github.com' ? 'https://api.github.com' : `${origin}/api/v3`
    case 'gitlab':
      return `${origin}/api/v4`
    case 'bitbucket':
      return 'https://api.bitbucket.org/2.0'
    case 'azure':
      return 'https://dev.azure.com'
  }
}

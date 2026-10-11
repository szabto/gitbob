import { afterEach, describe, expect, it } from 'vitest'
import { AzureDevOpsAdapter } from '../../src/providers/azure'
import { BitbucketAdapter } from '../../src/providers/bitbucket'
import { GitHubAdapter } from '../../src/providers/github'
import { GitLabAdapter } from '../../src/providers/gitlab'
import { safeCloneUrl, safeSshUrl } from '../../src/providers/util'
import { basic, startFakeApi, type FakeApi } from './fakeServer'

let api: FakeApi | null = null
afterEach(async () => {
  await api?.close()
  api = null
})

describe('listRepositories', () => {
  it('GitHub: lists the user’s repositories across pages, newest first, with clone URLs', async () => {
    api = await startFakeApi({ isAuthorized: (h) => h.authorization === 'Bearer t' })
    api.route('GET /user/repos', (req, base) => {
      const page = Number(req.query.get('page') ?? 1)
      const repo = (n: number, over = {}) => ({
        full_name: `octo/r${n}`, description: n === 1 ? 'First' : null, private: n === 2,
        clone_url: `https://github.com/octo/r${n}.git`, ssh_url: `git@github.com:octo/r${n}.git`, pushed_at: `2026-10-0${n}T00:00:00Z`, ...over,
      })
      return page === 1
        ? { body: [repo(1), repo(2)], headers: { link: `<${base}/user/repos?page=2>; rel="next"` } }
        : { body: [repo(3, { clone_url: 'file:///etc/passwd' }), repo(4)] }
    })
    const repos = await new GitHubAdapter({ token: 't', baseUrl: api.baseUrl, pageSize: 2 }).listRepositories('github.com')
    expect(repos.map((r) => r.fullName)).toEqual(['octo/r1', 'octo/r2', 'octo/r4'])
    expect(repos[0]).toEqual({
      kind: 'github', host: 'github.com', fullName: 'octo/r1', description: 'First', private: false,
      cloneUrl: 'https://github.com/octo/r1.git', sshUrl: 'git@github.com:octo/r1.git', updatedAt: '2026-10-01T00:00:00Z',
    })
    expect(repos[1]!.private).toBe(true)
    const q = api.requests[0]!.query
    expect(q.get('sort')).toBe('updated')
    expect(q.get('affiliation')).toBe('owner,collaborator,organization_member')
  })

  it('GitLab: lists projects the user is a member of', async () => {
    api = await startFakeApi({ prefix: '/api/v4', isAuthorized: (h) => h['private-token'] === 't' })
    api.route('GET /api/v4/projects', () => ({
      body: [
        { path_with_namespace: 'grp/sub/app', description: 'App', visibility: 'internal', http_url_to_repo: 'https://gitlab.com/grp/sub/app.git', ssh_url_to_repo: 'git@gitlab.com:grp/sub/app.git', last_activity_at: '2026-10-01T00:00:00Z' },
        { path_with_namespace: 'grp/open', visibility: 'public', http_url_to_repo: 'https://gitlab.com/grp/open.git' },
      ],
    }))
    const repos = await new GitLabAdapter({ token: 't', baseUrl: api.baseUrl }).listRepositories('gitlab.com')
    expect(repos.map((r) => [r.fullName, r.private, r.sshUrl])).toEqual([
      ['grp/sub/app', true, 'git@gitlab.com:grp/sub/app.git'],
      ['grp/open', false, null],
    ])
    expect(api.requests[0]!.query.get('membership')).toBe('true')
  })

  it('Bitbucket: strips the user name from https clone links and follows `next`', async () => {
    api = await startFakeApi({ isAuthorized: (h) => h.authorization === basic('me', 'pw') })
    api.route('GET /repositories', (req, base) => {
      const second = req.query.get('page') === '2'
      const repo = (name: string) => ({
        full_name: `ws/${name}`, is_private: true, updated_on: '2026-10-01T00:00:00Z',
        links: { clone: [{ name: 'https', href: `https://me@bitbucket.org/ws/${name}.git` }, { name: 'ssh', href: `git@bitbucket.org:ws/${name}.git` }] },
      })
      return { body: second ? { values: [repo('b')] } : { values: [repo('a')], next: `${base}/repositories?page=2` } }
    })
    const repos = await new BitbucketAdapter({ token: 'me:pw', baseUrl: api.baseUrl }).listRepositories('bitbucket.org')
    expect(repos.map((r) => [r.fullName, r.cloneUrl, r.sshUrl])).toEqual([
      ['ws/a', 'https://bitbucket.org/ws/a.git', 'git@bitbucket.org:ws/a.git'],
      ['ws/b', 'https://bitbucket.org/ws/b.git', 'git@bitbucket.org:ws/b.git'],
    ])
    expect(api.requests[0]!.query.get('role')).toBe('member')
  })

  it('Azure DevOps: lists repositories of every organization the user belongs to', async () => {
    api = await startFakeApi({ isAuthorized: (h) => h.authorization === basic('', 'pat') })
    api.route('GET /_apis/profile/profiles/me', () => ({ body: { id: 'user-1', displayName: 'Me' } }))
    api.route('GET /_apis/accounts', (req) => {
      expect(req.query.get('memberId')).toBe('user-1')
      return { body: { count: 2, value: [{ accountName: 'contoso' }, { accountName: 'fabrikam' }] } }
    })
    const repo = (org: string, name: string, updated: string, over = {}) => ({
      name, remoteUrl: `https://${org}@dev.azure.com/${org}/Web/_git/${name}`, sshUrl: `git@ssh.dev.azure.com:v3/${org}/Web/${name}`,
      project: { name: 'Web', visibility: 'private', lastUpdateTime: updated }, ...over,
    })
    api.route('GET /contoso/_apis/git/repositories', () => ({ body: { value: [repo('contoso', 'site', '2026-10-01'), repo('contoso', 'old', '2026-01-01', { isDisabled: true })] } }))
    api.route('GET /fabrikam/_apis/git/repositories', () => ({ body: { value: [repo('fabrikam', 'api', '2026-10-05')] } }))
    const repos = await new AzureDevOpsAdapter({ token: 'pat', baseUrl: api.baseUrl, profileBaseUrl: api.baseUrl }).listRepositories('dev.azure.com')
    expect(repos.map((r) => [r.fullName, r.cloneUrl])).toEqual([
      ['fabrikam/Web/api', 'https://dev.azure.com/fabrikam/Web/_git/api'],
      ['contoso/Web/site', 'https://dev.azure.com/contoso/Web/_git/site'],
    ])
  })

  it('clone URL helpers accept only https/ssh forms', () => {
    expect(safeCloneUrl('https://u:p@host/x.git')).toBe('https://host/x.git')
    expect(safeCloneUrl('ext::sh -c x')).toBeNull()
    expect(safeCloneUrl('file:///x')).toBeNull()
    expect(safeSshUrl('git@host:o/r.git')).toBe('git@host:o/r.git')
    expect(safeSshUrl('ssh://git@host/o/r.git')).toBe('ssh://git@host/o/r.git')
    expect(safeSshUrl('-oProxyCommand=x@h:y')).toBeNull()
    expect(safeSshUrl('git@host:o r')).toBeNull()
  })
})

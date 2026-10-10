import { describe, expect, it } from 'vitest'
import { defaultApiBaseUrl, parseRemoteUrl, type SelfHostedProvider } from '../../src/providers/detect'
import type { RepoRef } from '../../src/providers/types'

type Row = [url: string, expected: Partial<RepoRef> | null]

const GH = { kind: 'github', host: 'github.com', owner: 'octo-org', repo: 'hello.world', webUrl: 'https://github.com/octo-org/hello.world' } as const

const github: Row[] = [
  ['https://github.com/octo-org/hello.world.git', GH],
  ['https://github.com/octo-org/hello.world', GH],
  ['https://github.com/octo-org/hello.world/', GH],
  ['https://user:s3cret@github.com/octo-org/hello.world.git', GH],
  ['https://x-access-token:ghp_abc@github.com/octo-org/hello.world', GH],
  ['git@github.com:octo-org/hello.world.git', GH],
  ['github.com:octo-org/hello.world.git', GH],
  ['ssh://git@github.com/octo-org/hello.world.git', GH],
  ['ssh://git@ssh.github.com:443/octo-org/hello.world.git', GH],
  ['git+ssh://git@github.com/octo-org/hello.world', GH],
  ['git://github.com/octo-org/hello.world.git', GH],
  ['  https://GitHub.com/octo-org/hello.world.git\n', GH],
  ['https://github.com/octo-org', null],
  ['https://github.com/octo-org/hello/tree/main', null],
]

const gitlab: Row[] = [
  ['https://gitlab.com/group/project.git', { kind: 'gitlab', host: 'gitlab.com', owner: 'group', repo: 'project', webUrl: 'https://gitlab.com/group/project' }],
  ['git@gitlab.com:group/sub/deeper/project.git', { kind: 'gitlab', owner: 'group/sub/deeper', repo: 'project', webUrl: 'https://gitlab.com/group/sub/deeper/project' }],
  ['https://oauth2:glpat-xyz@gitlab.com/group/sub/project', { owner: 'group/sub', repo: 'project', webUrl: 'https://gitlab.com/group/sub/project' }],
  ['ssh://git@altssh.gitlab.com:443/group/project.git', { kind: 'gitlab', host: 'gitlab.com', owner: 'group', repo: 'project' }],
  ['https://gitlab.com/project-only', null],
]

const bitbucket: Row[] = [
  ['https://jdoe@bitbucket.org/my-workspace/my-repo.git', { kind: 'bitbucket', host: 'bitbucket.org', owner: 'my-workspace', repo: 'my-repo', webUrl: 'https://bitbucket.org/my-workspace/my-repo' }],
  ['https://jdoe:app-pass@bitbucket.org/my-workspace/my-repo', { owner: 'my-workspace', repo: 'my-repo', webUrl: 'https://bitbucket.org/my-workspace/my-repo' }],
  ['git@bitbucket.org:my-workspace/my-repo.git', { kind: 'bitbucket', owner: 'my-workspace', repo: 'my-repo' }],
  ['https://bitbucket.org/my-workspace', null],
]

const AZ = { kind: 'azure', host: 'dev.azure.com', owner: 'contoso', project: 'Fabrikam', repo: 'web-app', webUrl: 'https://dev.azure.com/contoso/Fabrikam/_git/web-app' } as const

const azure: Row[] = [
  ['https://contoso@dev.azure.com/contoso/Fabrikam/_git/web-app', AZ],
  ['https://dev.azure.com/contoso/Fabrikam/_git/web-app', AZ],
  ['https://contoso:pat123@dev.azure.com/contoso/Fabrikam/_git/web-app', AZ],
  ['git@ssh.dev.azure.com:v3/contoso/Fabrikam/web-app', AZ],
  ['ssh://git@ssh.dev.azure.com/v3/contoso/Fabrikam/web-app', AZ],
  ['https://contoso.visualstudio.com/Fabrikam/_git/web-app', AZ],
  ['https://contoso.visualstudio.com/DefaultCollection/Fabrikam/_git/web-app', AZ],
  ['contoso@vs-ssh.visualstudio.com:v3/contoso/Fabrikam/web-app', AZ],
  [
    'https://dev.azure.com/contoso/My%20Project/_git/My%20Repo',
    { owner: 'contoso', project: 'My Project', repo: 'My Repo', webUrl: 'https://dev.azure.com/contoso/My%20Project/_git/My%20Repo' },
  ],
  ['https://dev.azure.com/contoso/_git/Fabrikam', { owner: 'contoso', project: 'Fabrikam', repo: 'Fabrikam' }],
  ['https://dev.azure.com/contoso/Fabrikam', null],
  ['git@ssh.dev.azure.com:v2/contoso/Fabrikam/web-app', null],
]

const invalid: Row[] = [
  ['', null],
  ['not a url', null],
  ['/home/me/repo', null],
  ['C:\\repos\\thing', null],
  ['C:/repos/thing', null],
  ['ftp://github.com/a/b', null],
  ['https://example.com/a/b.git', null],
  ['https://github.com/../etc/passwd', null],
  ['file:///tmp/repo.git', null],
]

describe('parseRemoteUrl', () => {
  for (const [group, rows] of Object.entries({ github, gitlab, bitbucket, azure, invalid })) {
    describe(group, () => {
      it.each(rows)('%s', (url, expected) => {
        const ref = parseRemoteUrl(url)
        if (expected === null) expect(ref).toBeNull()
        else expect(ref).toMatchObject(expected)
      })
    })
  }

  it('never keeps credentials from the URL', () => {
    const urls = [
      'https://user:s3cretpw@github.com/a/b.git',
      'https://oauth2:glpat-xyz@gitlab.com/g/p',
      'https://jdoe:app-pass@bitbucket.org/w/r',
      'https://contoso:pat123@dev.azure.com/contoso/P/_git/r',
    ]
    for (const url of urls) {
      const ref = parseRemoteUrl(url)
      expect(ref).not.toBeNull()
      const s = JSON.stringify(ref)
      expect(s).not.toMatch(/s3cretpw|glpat-xyz|app-pass|pat123|@/)
    }
  })

  describe('self-hosted', () => {
    const hosts: SelfHostedProvider[] = [
      { host: 'git.corp.example', kind: 'github' },
      { host: 'https://gitlab.example.org:8443/', kind: 'gitlab' },
      { host: 'bitbucket.corp.example', kind: 'bitbucket' },
    ]
    const rows: Row[] = [
      ['https://git.corp.example/team/svc.git', { kind: 'github', host: 'git.corp.example', owner: 'team', repo: 'svc', webUrl: 'https://git.corp.example/team/svc' }],
      ['git@git.corp.example:team/svc.git', { kind: 'github', host: 'git.corp.example', webUrl: 'https://git.corp.example/team/svc' }],
      ['https://gitlab.example.org:8443/a/b/c.git', { kind: 'gitlab', host: 'gitlab.example.org:8443', owner: 'a/b', repo: 'c', webUrl: 'https://gitlab.example.org:8443/a/b/c' }],
      ['ssh://git@gitlab.example.org:2222/a/c.git', { kind: 'gitlab', host: 'gitlab.example.org:8443', owner: 'a', repo: 'c', webUrl: 'https://gitlab.example.org:8443/a/c' }],
      ['https://bitbucket.corp.example/scm/p/r.git', null],
      ['https://unknown.example/a/b', null],
    ]
    it.each(rows)('%s', (url, expected) => {
      const ref = parseRemoteUrl(url, hosts)
      if (expected === null) expect(ref).toBeNull()
      else expect(ref).toMatchObject(expected)
    })

    it('is not used for hosts it was not registered for', () => {
      expect(parseRemoteUrl('https://git.corp.example/team/svc.git')).toBeNull()
    })
  })
})

describe('defaultApiBaseUrl', () => {
  it.each([
    ['https://github.com/a/b', 'https://api.github.com'],
    ['https://gitlab.com/g/p', 'https://gitlab.com/api/v4'],
    ['git@bitbucket.org:w/r.git', 'https://api.bitbucket.org/2.0'],
    ['https://dev.azure.com/o/p/_git/r', 'https://dev.azure.com'],
  ])('%s → %s', (url, api) => {
    expect(defaultApiBaseUrl(parseRemoteUrl(url)!)).toBe(api)
  })

  it('uses /api/v3 for GitHub Enterprise and /api/v4 for self-hosted GitLab', () => {
    const hosts: SelfHostedProvider[] = [
      { host: 'ghe.example', kind: 'github' },
      { host: 'gl.example:8443', kind: 'gitlab' },
    ]
    expect(defaultApiBaseUrl(parseRemoteUrl('git@ghe.example:a/b.git', hosts)!)).toBe('https://ghe.example/api/v3')
    expect(defaultApiBaseUrl(parseRemoteUrl('git@gl.example:a/b.git', hosts)!)).toBe('https://gl.example:8443/api/v4')
  })
})

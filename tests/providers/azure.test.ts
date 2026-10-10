import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AzureDevOpsAdapter } from '../../src/providers/azure'
import type { RepoRef } from '../../src/providers/types'
import { basic, startFakeApi, catchErr, type FakeApi } from './fakeServer'

const PAT = 'azpat5ecretvalue0123456789abcdefghijklmnopq'
const REPO: RepoRef = {
  kind: 'azure',
  host: 'dev.azure.com',
  owner: 'contoso',
  project: 'My Project',
  repo: 'web-app',
  webUrl: 'https://dev.azure.com/contoso/My%20Project/_git/web-app',
}
const R = '/contoso/My%20Project/_apis/git/repositories/web-app'
const SHA = 'be67f8871a4d2c75f13a51c1d3c30ac0d74d4ef4'
const REPO_WEB = 'https://dev.azure.com/contoso/My%20Project/_git/web-app'

/** Shape follows https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests */
function azPull(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { id: '3411ebc1', name: 'web-app', url: 'https://dev.azure.com/contoso/_apis/git/repositories/3411ebc1', webUrl: REPO_WEB, project: { name: 'My Project' } },
    pullRequestId: id,
    codeReviewId: id,
    status: 'active',
    createdBy: { displayName: 'Normal Paulk', uniqueName: 'normal@contoso.com', id: 'd6245f20' },
    creationDate: '2024-06-17T16:11:33.0012345Z',
    title: `PR ${id}`,
    description: 'Adding a new feature',
    sourceRefName: `refs/heads/npaulk/feature-${id}`,
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    isDraft: false,
    mergeId: 'f5fc8381',
    url: `https://dev.azure.com/contoso/_apis/git/repositories/3411ebc1/pullRequests/${id}`,
    supportsIterations: true,
    ...over,
  }
}

let api: FakeApi
let az: AzureDevOpsAdapter
beforeEach(async () => {
  api = await startFakeApi({ isAuthorized: (h) => h.authorization === basic('', PAT) })
  az = new AzureDevOpsAdapter({ token: PAT, baseUrl: api.baseUrl, profileBaseUrl: api.baseUrl, pageSize: 2 })
})
afterEach(async () => {
  await api.close()
})

describe('AzureDevOpsAdapter', () => {
  it('getUser reads the profile API with Basic :PAT', async () => {
    api.route('GET /_apis/profile/profiles/me', (req) => {
      expect(req.query.get('api-version')).toBe('7.1')
      return {
        body: { displayName: 'Normal Paulk', publicAlias: 'd6245f20', emailAddress: 'normal@contoso.com', id: 'd6245f20' },
      }
    })
    expect(await az.getUser()).toEqual({ login: 'normal@contoso.com', name: 'Normal Paulk' })
  })

  it('pages with $top/$skip for at most 3 pages', async () => {
    api.route(`GET ${R}/pullrequests`, (req) => {
      const skip = Number(req.query.get('$skip'))
      return { body: { count: 2, value: [azPull(skip + 1), azPull(skip + 2)] } }
    })
    const prs = await az.listPullRequests(REPO, { state: 'open' })
    expect(prs.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(api.requests).toHaveLength(3)
    expect(api.requests.map((r) => r.query.get('$skip'))).toEqual(['0', '2', '4'])
    expect(api.requests[0]!.query.get('$top')).toBe('2')
    expect(api.requests[0]!.query.get('searchCriteria.status')).toBe('active')
    expect(api.requests[0]!.query.get('api-version')).toBe('7.1')
  })

  it('stops when a page is not full', async () => {
    api.route(`GET ${R}/pullrequests`, () => ({ body: { count: 1, value: [azPull(1)] } }))
    expect(await az.listPullRequests(REPO, { state: 'all' })).toHaveLength(1)
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]!.query.get('searchCriteria.status')).toBe('all')
  })

  it('maps statuses, drafts, refs and web URLs', async () => {
    api.route(`GET ${R}/pullrequests`, () => ({
      body: {
        count: 4,
        value: [
          azPull(1),
          azPull(2, { isDraft: true }),
          azPull(3, { status: 'completed', closedDate: '2024-06-20T00:00:00Z' }),
          azPull(4, { status: 'abandoned', closedDate: '2024-06-21T00:00:00Z' }),
        ],
      },
    }))
    const prs = await new AzureDevOpsAdapter({ token: PAT, baseUrl: api.baseUrl }).listPullRequests(REPO, { state: 'all' })
    expect(prs[0]).toEqual({
      id: 1,
      number: 1,
      title: 'PR 1',
      author: 'normal@contoso.com',
      state: 'open',
      draft: false,
      sourceBranch: 'npaulk/feature-1',
      targetBranch: 'main',
      url: `${REPO_WEB}/pullrequest/1`,
      createdAt: '2024-06-17T16:11:33.0012345Z',
      updatedAt: '2024-06-17T16:11:33.0012345Z',
    })
    expect(prs.map((p) => [p.state, p.draft])).toEqual([
      ['open', false],
      ['open', true],
      ['merged', false],
      ['closed', false],
    ])
    expect(prs[2]!.updatedAt).toBe('2024-06-20T00:00:00Z')
  })

  it('summarises commit statuses', async () => {
    api.route(`GET ${R}/commits/${SHA}/statuses`, (req) => {
      expect(req.query.get('latestOnly')).toBe('true')
      return {
        body: {
          count: 3,
          value: [
            { state: 'succeeded', description: 'Build ok', context: { name: 'build', genre: 'ci' }, targetUrl: 'https://ci/1' },
            { state: 'pending', description: 'Running', context: { name: 'tests', genre: 'ci' }, targetUrl: 'https://ci/2' },
            { state: 'notApplicable', context: { name: 'scan', genre: 'sec' } },
          ],
        },
      }
    })
    const big = new AzureDevOpsAdapter({ token: PAT, baseUrl: api.baseUrl })
    expect(await big.getChecks(REPO, SHA)).toEqual({ state: 'pending', total: 3, failed: 0, pending: 1, url: 'https://ci/2' })
  })

  it('creates a pull request with refs/heads/ prefixes and isDraft', async () => {
    api.route(`POST ${R}/pullrequests`, (req) => {
      const b = req.body as Record<string, unknown>
      return { status: 201, body: azPull(77, { title: b.title, isDraft: b.isDraft, sourceRefName: b.sourceRefName }) }
    })
    const pr = await az.createPullRequest(REPO, {
      title: 'New feature',
      body: 'Desc',
      sourceBranch: 'feature/new',
      targetBranch: 'main',
      draft: true,
    })
    expect(api.requests[0]!.query.get('api-version')).toBe('7.1')
    expect(api.requests[0]!.body).toEqual({
      sourceRefName: 'refs/heads/feature/new',
      targetRefName: 'refs/heads/main',
      title: 'New feature',
      description: 'Desc',
      isDraft: true,
    })
    expect(pr).toMatchObject({ number: 77, draft: true, sourceBranch: 'feature/new', url: `${REPO_WEB}/pullrequest/77` })
  })

  it('enforces Azure’s 4000 character description limit', async () => {
    await expect(
      az.createPullRequest(REPO, { title: 't', body: 'x'.repeat(4001), sourceBranch: 'a', targetBranch: 'b', draft: false }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
  })

  it('maps errors without leaking the PAT', async () => {
    api.route(`POST ${R}/pullrequests`, () => ({
      status: 409,
      body: {
        $id: '1',
        message: 'TF401179: An active pull request for the source and target branch already exists.',
        typeName: 'Microsoft.TeamFoundation.Git.Server.GitPullRequestExistsException',
      },
    }))
    const err = await catchErr(
      az.createPullRequest(REPO, { title: 't', body: '', sourceBranch: 'a', targetBranch: 'b', draft: false }),
    )
    expect(err.code).toBe('BAD_RESPONSE')
    expect(err.message).toContain('TF401179')

    api.route('GET /_apis/profile/profiles/me', () => ({ status: 203, raw: '<html><title>Sign In</title></html>' }))
    const signIn = await catchErr(az.getUser())
    expect(signIn.code).toBe('UNAUTHORIZED')
    expect(signIn.message).not.toContain(PAT)

    const wrong = new AzureDevOpsAdapter({ token: 'wrongpat000000000000', baseUrl: api.baseUrl })
    const e = await catchErr(wrong.listPullRequests(REPO, { state: 'open' }))
    expect(e.code).toBe('UNAUTHORIZED')
    expect(e.message).not.toContain('wrongpat000000000000')
  })

  it('requires a project on the repository', async () => {
    await expect(az.listPullRequests({ ...REPO, project: undefined }, { state: 'open' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('builds the create pull request URL', () => {
    expect(az.pullRequestUrlForBranch(REPO, 'feature/x')).toBe(`${REPO_WEB}/pullrequestcreate?sourceRef=feature%2Fx`)
  })
})

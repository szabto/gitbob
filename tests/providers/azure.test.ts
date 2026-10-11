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

describe('AzureDevOpsAdapter review & merge', () => {
  const PR = `${R}/pullrequests/7`
  const ME = '0d1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8'

  function detailRoute(over: Record<string, unknown> = {}): void {
    api.route(`GET ${PR}`, () => ({
      body: azPull(7, {
        lastMergeSourceCommit: { commitId: SHA },
        lastMergeTargetCommit: { commitId: 'a'.repeat(40) },
        reviewers: [
          { uniqueName: 'a@contoso.com', vote: 10 },
          { uniqueName: 'b@contoso.com', vote: 5 },
          { uniqueName: 'c@contoso.com', vote: 0, isRequired: true },
          { uniqueName: 'd@contoso.com', vote: -5 },
          { displayName: '[My Project]\\Team', vote: -10, isContainer: true },
        ],
        ...over,
      }),
    }))
  }

  it('getPullRequest maps votes, commits and mergeStatus', async () => {
    detailRoute()
    expect(await az.getPullRequest(REPO, 7)).toMatchObject({
      number: 7,
      body: 'Adding a new feature',
      headSha: SHA,
      baseSha: 'a'.repeat(40),
      mergeable: 'yes',
      mergeMethods: ['merge', 'squash', 'rebase'],
      reviewers: [
        { login: 'a@contoso.com', state: 'approved' },
        { login: 'b@contoso.com', state: 'approved' },
        { login: 'c@contoso.com', state: 'pending' },
        { login: 'd@contoso.com', state: 'changes-requested' },
        { login: '[My Project]\\Team', state: 'changes-requested' },
      ],
      additions: null,
      headRepoIsFork: false,
    })
    expect(api.requests[0]!.query.get('api-version')).toBe('7.1')
  })

  it.each([
    [{ mergeStatus: 'conflicts' }, 'conflicts'],
    [{ mergeStatus: 'queued' }, 'unknown'],
    [{ mergeStatus: 'rejectedByPolicy' }, 'no'],
    [{ isDraft: true }, 'no'],
    [{ status: 'completed' }, 'no'],
  ])('maps mergeability %j → %s', async (over, expected) => {
    detailRoute(over)
    expect((await az.getPullRequest(REPO, 7)).mergeable).toBe(expected)
  })

  it('detects fork pull requests', async () => {
    detailRoute({ forkSource: { name: 'refs/heads/f', repository: { name: 'web-app-fork' } } })
    expect((await az.getPullRequest(REPO, 7)).headRepoIsFork).toBe(true)
  })

  it('listComments flattens threads, skipping system and deleted comments', async () => {
    api.route(`GET ${R}/pullRequests/7/threads`, () => ({
      body: {
        count: 3,
        value: [
          {
            id: 1,
            comments: [
              { id: 1, content: 'general', commentType: 'text', author: { uniqueName: 'a@contoso.com' }, publishedDate: '2024-06-02T00:00:00Z' },
              { id: 2, content: 'reply', commentType: 'text', author: { uniqueName: 'b@contoso.com' }, publishedDate: '2024-06-03T00:00:00Z' },
              { id: 3, content: 'gone', commentType: 'text', isDeleted: true, author: {}, publishedDate: '2024-06-03T00:00:00Z' },
            ],
          },
          {
            id: 2,
            threadContext: { filePath: '/src/app.ts', rightFileStart: { line: 42, offset: 1 } },
            comments: [{ id: 1, content: 'inline', commentType: 'text', author: { displayName: 'Dee' }, publishedDate: '2024-06-01T00:00:00Z' }],
          },
          { id: 3, comments: [{ id: 1, content: 'Normal Paulk voted 10', commentType: 'system', author: {}, publishedDate: '2024-06-01T00:00:00Z' }] },
        ],
      },
    }))
    expect(await az.listComments(REPO, 7)).toEqual([
      { id: '2:1', author: 'Dee', body: 'inline', createdAt: '2024-06-01T00:00:00Z', path: 'src/app.ts', line: 42 },
      { id: '1:1', author: 'a@contoso.com', body: 'general', createdAt: '2024-06-02T00:00:00Z' },
      { id: '1:2', author: 'b@contoso.com', body: 'reply', createdAt: '2024-06-03T00:00:00Z' },
    ])
  })

  it('addComment creates an active thread', async () => {
    api.route(`POST ${R}/pullRequests/7/threads`, (req) => {
      const b = req.body as { comments: { content: string }[] }
      return {
        body: { id: 9, status: 'active', comments: [{ id: 1, content: b.comments[0]!.content, commentType: 'text', author: { uniqueName: 'me@contoso.com' }, publishedDate: '2024-07-01T00:00:00Z' }] },
      }
    })
    expect(await az.addComment(REPO, 7, 'nice')).toEqual({ id: '9:1', author: 'me@contoso.com', body: 'nice', createdAt: '2024-07-01T00:00:00Z' })
    expect(api.requests[0]!.body).toEqual({ comments: [{ parentCommentId: 0, content: 'nice', commentType: 1 }], status: 1 })
  })

  it('submitReview votes as the connectionData user and posts the body as a thread', async () => {
    api.route('GET /contoso/_apis/connectionData', () => ({ body: { authenticatedUser: { id: ME, providerDisplayName: 'Me' } } }))
    api.route(`PUT ${R}/pullRequests/7/reviewers/${ME}`, (req) => ({ body: { id: ME, vote: (req.body as { vote: number }).vote } }))
    api.route(`POST ${R}/pullRequests/7/threads`, () => ({ body: { id: 1, comments: [] } }))
    await az.submitReview(REPO, 7, 'approve', '')
    await az.submitReview(REPO, 7, 'request-changes', 'please rename')
    await az.submitReview(REPO, 7, 'comment', 'just a note')
    expect(api.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      'GET /contoso/_apis/connectionData',
      `PUT ${R}/pullRequests/7/reviewers/${ME}`,
      // connectionData is cached per organization
      `PUT ${R}/pullRequests/7/reviewers/${ME}`,
      `POST ${R}/pullRequests/7/threads`,
      `POST ${R}/pullRequests/7/threads`,
    ])
    expect(api.requests[1]!.body).toEqual({ vote: 10 })
    expect(api.requests[2]!.body).toEqual({ vote: -5 })
    expect((api.requests[3]!.body as { comments: { content: string }[] }).comments[0]!.content).toBe('please rename')
  })

  it('mergePullRequest completes with the expected head and strategy', async () => {
    api.route(`PATCH ${PR}`, (req) => {
      const b = req.body as Record<string, unknown>
      return { body: azPull(7, { status: 'completed', lastMergeCommit: { commitId: 'c'.repeat(40) }, completionOptions: b.completionOptions }) }
    })
    const r = await az.mergePullRequest(REPO, 7, { method: 'squash', title: 'T', message: 'M', expectedHeadSha: SHA, deleteSourceBranch: true })
    expect(r).toEqual({ merged: true, sha: 'c'.repeat(40), message: 'Pull request 7 completed.' })
    expect(api.requests[0]!.body).toEqual({
      status: 'completed',
      lastMergeSourceCommit: { commitId: SHA },
      completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: true, mergeCommitMessage: 'T\n\nM' },
    })
  })

  it('mergePullRequest reads the current head when none is given and reports async completion', async () => {
    detailRoute()
    api.route(`PATCH ${PR}`, () => ({ body: azPull(7, { status: 'active', mergeStatus: 'queued' }) }))
    const r = await az.mergePullRequest(REPO, 7, { method: 'rebase' })
    expect(r.merged).toBe(false)
    expect(r.message).toMatch(/completing/)
    const patch = api.requests.find((q) => q.method === 'PATCH')!
    expect(patch.body).toEqual({
      status: 'completed',
      lastMergeSourceCommit: { commitId: SHA },
      completionOptions: { mergeStrategy: 'rebase', deleteSourceBranch: false },
    })
    await az.mergePullRequest(REPO, 7, { method: 'merge' })
    expect((api.requests.filter((q) => q.method === 'PATCH')[1]!.body as { completionOptions: { mergeStrategy: string } }).completionOptions.mergeStrategy).toBe('noFastForward')
  })

  it('mergePullRequest maps stale head (409), policy errors (400) and conflicts to CONFLICT', async () => {
    api.route(`PATCH ${PR}`, () => ({ status: 409, body: { message: 'TF401192: The source branch was updated after the pull request was last evaluated.' } }))
    const e1 = await catchErr(az.mergePullRequest(REPO, 7, { method: 'merge', expectedHeadSha: SHA }))
    expect(e1).toMatchObject({ code: 'CONFLICT', status: 409 })
    expect(e1.message).toContain('TF401192')
    expect(e1.message).not.toContain(PAT)
    api.route(`PATCH ${PR}`, () => ({ status: 400, body: { message: 'TF401181: The pull request cannot be completed because of policy.' } }))
    expect((await catchErr(az.mergePullRequest(REPO, 7, { method: 'merge', expectedHeadSha: SHA }))).code).toBe('CONFLICT')
    api.route(`PATCH ${PR}`, () => ({ body: azPull(7, { status: 'active', mergeStatus: 'conflicts' }) }))
    const e3 = await catchErr(az.mergePullRequest(REPO, 7, { method: 'merge', expectedHeadSha: SHA }))
    expect(e3.code).toBe('CONFLICT')
    expect(e3.message).toMatch(/conflicts/)
  })

  it('returns the merge refspec and validates input', async () => {
    expect(az.pullRequestRefspec(REPO, 7)).toBe('refs/pull/7/merge')
    await expect(az.addComment(REPO, 7, '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(az.mergePullRequest(REPO, -2, { method: 'merge' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
  })
})

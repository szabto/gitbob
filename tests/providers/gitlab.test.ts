import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitLabAdapter } from '../../src/providers/gitlab'
import type { RepoRef } from '../../src/providers/types'
import { startFakeApi, catchErr, type FakeApi } from './fakeServer'

const TOKEN = 'glpat-TESTTOKEN_abcdefghij'
const REPO: RepoRef = {
  kind: 'gitlab',
  host: 'gitlab.com',
  owner: 'group/sub',
  repo: 'proj',
  webUrl: 'https://gitlab.com/group/sub/proj',
}
const P = '/api/v4/projects/group%2Fsub%2Fproj'
const SHA = '18f3e63d05582537db6d183d9d557be09e1f90c8'

/** Shape follows https://docs.gitlab.com/api/merge_requests/#list-project-merge-requests */
function mr(iid: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5000 + iid,
    iid,
    project_id: 3,
    title: `MR ${iid}`,
    description: 'desc',
    state: 'opened',
    created_at: '2024-02-01T10:00:00.000Z',
    updated_at: '2024-02-02T10:00:00.000Z',
    merged_at: null,
    closed_at: null,
    target_branch: 'main',
    source_branch: `topic/${iid}`,
    author: { id: 1, username: 'admin', name: 'Administrator', state: 'active' },
    draft: false,
    work_in_progress: false,
    merge_status: 'can_be_merged',
    sha: SHA,
    web_url: `https://gitlab.com/group/sub/proj/-/merge_requests/${iid}`,
    ...over,
  }
}

let api: FakeApi
let gl: GitLabAdapter
beforeEach(async () => {
  api = await startFakeApi({ prefix: '/api/v4', isAuthorized: (h) => h['private-token'] === TOKEN })
  gl = new GitLabAdapter({ token: TOKEN, baseUrl: api.baseUrl, pageSize: 2 })
})
afterEach(async () => {
  await api.close()
})

describe('GitLabAdapter', () => {
  it('getUser uses PRIVATE-TOKEN and maps username', async () => {
    api.route('GET /api/v4/user', () => ({ body: { id: 1, username: 'jsmith', name: 'John Smith', state: 'active' } }))
    expect(await gl.getUser()).toEqual({ login: 'jsmith', name: 'John Smith' })
    expect(api.requests[0]!.headers.authorization).toBeUndefined()
  })

  it('supports bearer auth for OAuth tokens', async () => {
    await api.close()
    api = await startFakeApi({ prefix: '/api/v4', isAuthorized: (h) => h.authorization === `Bearer ${TOKEN}` })
    api.route('GET /api/v4/user', () => ({ body: { username: 'jsmith', name: 'John' } }))
    const bearer = new GitLabAdapter({ token: TOKEN, baseUrl: api.baseUrl, authScheme: 'bearer' })
    expect((await bearer.getUser()).login).toBe('jsmith')
  })

  it('lists merge requests with the url-encoded project path and Link pagination', async () => {
    api.route(`GET ${P}/merge_requests`, (req, base) => {
      const page = Number(req.query.get('page') ?? '1')
      const headers: Record<string, string> =
        page < 2
          ? { link: `<${base}/projects/group%2Fsub%2Fproj/merge_requests?page=${page + 1}&per_page=2&state=opened>; rel="next"`, 'x-next-page': String(page + 1) }
          : {}
      return { body: [mr(page * 10 + 1), mr(page * 10 + 2)], headers }
    })
    const prs = await gl.listPullRequests(REPO, { state: 'open' })
    expect(prs.map((p) => p.number)).toEqual([11, 12, 21, 22])
    expect(api.requests).toHaveLength(2)
    expect(api.requests[0]!.query.get('state')).toBe('opened')
    expect(api.requests[0]!.query.get('per_page')).toBe('2')
  })

  it('maps states, drafts and authors', async () => {
    api.route(`GET ${P}/merge_requests`, () => ({
      body: [
        mr(1),
        mr(2, { draft: true, title: 'Draft: wip' }),
        mr(3, { work_in_progress: true }),
        mr(4, { state: 'merged', merged_at: '2024-03-01T00:00:00Z' }),
        mr(5, { state: 'closed' }),
        mr(6, { state: 'locked' }),
      ],
    }))
    const prs = await new GitLabAdapter({ token: TOKEN, baseUrl: api.baseUrl }).listPullRequests(REPO, { state: 'all' })
    expect(api.requests[0]!.query.get('state')).toBe('all')
    expect(prs[0]).toEqual({
      id: 5001,
      number: 1,
      title: 'MR 1',
      author: 'admin',
      state: 'open',
      draft: false,
      sourceBranch: 'topic/1',
      targetBranch: 'main',
      url: 'https://gitlab.com/group/sub/proj/-/merge_requests/1',
      createdAt: '2024-02-01T10:00:00.000Z',
      updatedAt: '2024-02-02T10:00:00.000Z',
    })
    expect(prs.map((p) => [p.state, p.draft])).toEqual([
      ['open', false],
      ['open', true],
      ['open', true],
      ['merged', false],
      ['closed', false],
      ['open', false],
    ])
  })

  it('summarises commit statuses, honouring allow_failure', async () => {
    api.route(`GET ${P}/repository/commits/${SHA}/statuses`, () => ({
      body: [
        { id: 1, sha: SHA, ref: 'main', status: 'success', name: 'build', allow_failure: false, target_url: 'https://gitlab.com/j/1' },
        { id: 2, sha: SHA, ref: 'main', status: 'failed', name: 'lint', allow_failure: true, target_url: 'https://gitlab.com/j/2' },
        { id: 3, sha: SHA, ref: 'main', status: 'running', name: 'test', allow_failure: false, target_url: 'https://gitlab.com/j/3' },
        { id: 4, sha: SHA, ref: 'main', status: 'manual', name: 'deploy', allow_failure: true, target_url: 'https://gitlab.com/j/4' },
      ],
    }))
    const big = new GitLabAdapter({ token: TOKEN, baseUrl: api.baseUrl })
    expect(await big.getChecks(REPO, SHA)).toEqual({
      state: 'pending',
      total: 4,
      failed: 0,
      pending: 1,
      url: 'https://gitlab.com/j/3',
    })
    api.route(`GET ${P}/repository/commits/${SHA}/statuses`, () => ({
      body: [{ id: 5, status: 'failed', allow_failure: false, target_url: 'https://gitlab.com/j/5' }],
    }))
    expect(await big.getChecks(REPO, SHA)).toMatchObject({ state: 'failure', failed: 1 })
    api.route(`GET ${P}/repository/commits/${SHA}/statuses`, () => ({ body: [] }))
    expect((await big.getChecks(REPO, SHA)).state).toBe('none')
  })

  it('creates a merge request, marking drafts with the Draft: prefix', async () => {
    api.route(`POST ${P}/merge_requests`, (req) => {
      const b = req.body as Record<string, string>
      return {
        status: 201,
        body: mr(7, { title: b.title, draft: b.title!.startsWith('Draft:'), source_branch: b.source_branch, target_branch: b.target_branch }),
      }
    })
    const pr = await gl.createPullRequest(REPO, {
      title: 'Add thing',
      body: 'Body',
      sourceBranch: 'topic/x',
      targetBranch: 'main',
      draft: true,
    })
    expect(api.requests[0]!.body).toEqual({
      source_branch: 'topic/x',
      target_branch: 'main',
      title: 'Draft: Add thing',
      description: 'Body',
    })
    expect(pr).toMatchObject({ number: 7, draft: true, state: 'open', sourceBranch: 'topic/x' })

    await gl.createPullRequest(REPO, { title: 'draft: already', body: '', sourceBranch: 'a', targetBranch: 'b', draft: true })
    expect((api.requests[1]!.body as Record<string, string>).title).toBe('Draft: already')
    await gl.createPullRequest(REPO, { title: 'Plain', body: '', sourceBranch: 'a', targetBranch: 'b', draft: false })
    expect((api.requests[2]!.body as Record<string, string>).title).toBe('Plain')
  })

  it('rejects draft titles that exceed GitLab’s limit once prefixed', async () => {
    await expect(
      gl.createPullRequest(REPO, { title: 'x'.repeat(250), body: '', sourceBranch: 'a', targetBranch: 'b', draft: true }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
  })

  it('maps GitLab error payloads', async () => {
    api.route(`POST ${P}/merge_requests`, () => ({
      status: 409,
      body: { message: ['Another open merge request already exists for this source branch: !1'] },
    }))
    const err = await catchErr(
      gl.createPullRequest(REPO, { title: 't', body: '', sourceBranch: 'a', targetBranch: 'b', draft: false }),
    )
    expect(err.code).toBe('BAD_RESPONSE')
    expect(err.message).toContain('Another open merge request')

    api.route('GET /api/v4/user', () => ({ status: 429, headers: { 'retry-after': '12' }, body: { message: 'Retry later' } }))
    await expect(gl.getUser()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 12 })

    const wrong = new GitLabAdapter({ token: 'glpat-WRONG_123456', baseUrl: api.baseUrl })
    const e = await catchErr(wrong.getUser())
    expect(e.code).toBe('UNAUTHORIZED')
    expect(e.message).not.toContain('glpat-WRONG_123456')
    await expect(gl.listPullRequests({ ...REPO, repo: 'other' }, { state: 'open' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('builds the new merge request URL', () => {
    expect(gl.pullRequestUrlForBranch(REPO, 'topic/x')).toBe(
      'https://gitlab.com/group/sub/proj/-/merge_requests/new?merge_request%5Bsource_branch%5D=topic%2Fx',
    )
  })
})

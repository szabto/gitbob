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

describe('GitLabAdapter review & merge', () => {
  const MR = `${P}/merge_requests/7`

  function detailRoutes(over: Record<string, unknown> = {}, project: Record<string, unknown> = {}): void {
    api.route(`GET ${MR}`, () => ({
      body: mr(7, {
        description: 'MR body',
        detailed_merge_status: 'mergeable',
        has_conflicts: false,
        changes_count: '5',
        source_project_id: 3,
        target_project_id: 3,
        diff_refs: { base_sha: 'a'.repeat(40), head_sha: SHA, start_sha: 'a'.repeat(40) },
        reviewers: [{ username: 'rev1' }, { username: 'rev2' }],
        ...over,
      }),
    }))
    api.route(`GET ${MR}/approvals`, () => ({ body: { approved: true, approved_by: [{ user: { username: 'rev2' } }, { user: { username: 'lead' } }] } }))
    api.route(`GET ${P}`, () => ({ body: { id: 3, merge_method: 'merge', squash_option: 'default_off', ...project } }))
  }

  it('getPullRequest maps detail, approvals and allowed methods', async () => {
    detailRoutes()
    expect(await gl.getPullRequest(REPO, 7)).toMatchObject({
      number: 7,
      body: 'MR body',
      baseSha: 'a'.repeat(40),
      headSha: SHA,
      mergeable: 'yes',
      mergeMethods: ['merge', 'squash'],
      reviewers: [
        { login: 'rev1', state: 'pending' },
        { login: 'rev2', state: 'approved' },
        { login: 'lead', state: 'approved' },
      ],
      additions: null,
      deletions: null,
      changedFiles: 5,
      headRepoIsFork: false,
    })
  })

  it.each([
    [{ detailed_merge_status: 'conflict' }, 'conflicts'],
    [{ has_conflicts: true, detailed_merge_status: 'mergeable' }, 'conflicts'],
    [{ detailed_merge_status: 'checking' }, 'unknown'],
    [{ detailed_merge_status: 'not_approved' }, 'no'],
    [{ detailed_merge_status: undefined, merge_status: 'cannot_be_merged' }, 'conflicts'],
    [{ detailed_merge_status: undefined, merge_status: 'can_be_merged' }, 'yes'],
    [{ state: 'merged' }, 'no'],
  ])('maps mergeability %j → %s', async (over, expected) => {
    detailRoutes(over)
    expect((await gl.getPullRequest(REPO, 7)).mergeable).toBe(expected)
  })

  it.each([
    [{ merge_method: 'ff', squash_option: 'never' }, ['rebase']],
    [{ merge_method: 'rebase_merge', squash_option: 'always' }, ['squash']],
    [{ merge_method: 'ff', squash_option: 'default_on' }, ['rebase', 'squash']],
  ])('derives merge methods from project %j', async (project, expected) => {
    detailRoutes({ changes_count: '1000+', source_project_id: 9 }, project)
    const d = await gl.getPullRequest(REPO, 7)
    expect(d.mergeMethods).toEqual(expected)
    expect(d.changedFiles).toBeNull()
    expect(d.headRepoIsFork).toBe(true)
  })

  it('listComments skips system notes, maps diff positions and pages', async () => {
    api.route(`GET ${MR}/notes`, (req, base) => {
      const page = Number(req.query.get('page') ?? '1')
      const headers: Record<string, string> = page < 4 ? { link: `<${base}/projects/group%2Fsub%2Fproj/merge_requests/7/notes?page=${page + 1}>; rel="next"` } : {}
      return {
        headers,
        body: [
          { id: page * 10 + 1, body: 'added 1 commit', system: true, author: { username: 'bot' }, created_at: `2024-01-0${page}T00:00:00Z` },
          {
            id: page * 10 + 2,
            body: `note ${page}`,
            system: false,
            author: { username: 'alice' },
            created_at: `2024-01-0${page}T01:00:00Z`,
            ...(page === 2 ? { type: 'DiffNote', position: { new_path: 'lib/x.rb', new_line: 8, old_path: 'lib/x.rb', old_line: null } } : {}),
          },
        ],
      }
    })
    const notes = await gl.listComments(REPO, 7)
    expect(api.requests).toHaveLength(3)
    expect(api.requests[0]!.query.get('sort')).toBe('asc')
    expect(notes).toEqual([
      { id: '12', author: 'alice', body: 'note 1', createdAt: '2024-01-01T01:00:00Z' },
      { id: '22', author: 'alice', body: 'note 2', createdAt: '2024-01-02T01:00:00Z', path: 'lib/x.rb', line: 8 },
      { id: '32', author: 'alice', body: 'note 3', createdAt: '2024-01-03T01:00:00Z' },
    ])
  })

  it('addComment creates a note', async () => {
    api.route(`POST ${MR}/notes`, (req) => ({
      status: 201,
      body: { id: 99, body: (req.body as { body: string }).body, author: { username: 'me' }, created_at: '2024-03-01T00:00:00Z', system: false },
    }))
    expect(await gl.addComment(REPO, 7, 'hello')).toEqual({ id: '99', author: 'me', body: 'hello', createdAt: '2024-03-01T00:00:00Z' })
    expect(api.requests[0]!.body).toEqual({ body: 'hello' })
  })

  it('submitReview: approve, comment, and request-changes as unapprove + note', async () => {
    api.route(`POST ${MR}/approve`, () => ({ status: 201, body: { approved: true } }))
    api.route(`POST ${MR}/unapprove`, () => ({ status: 404, body: { message: '404 Not Found' } }))
    api.route(`POST ${MR}/notes`, () => ({ status: 201, body: { id: 1, body: 'x', author: { username: 'me' }, created_at: '' } }))
    await gl.submitReview(REPO, 7, 'approve', '')
    expect(api.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([`POST ${MR}/approve`])
    api.requests.length = 0
    await gl.submitReview(REPO, 7, 'approve', 'ship it')
    expect(api.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([`POST ${MR}/approve`, `POST ${MR}/notes`])
    api.requests.length = 0
    await gl.submitReview(REPO, 7, 'comment', 'a comment')
    expect(api.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([`POST ${MR}/notes`])
    api.requests.length = 0
    await gl.submitReview(REPO, 7, 'request-changes', 'needs work')
    expect(api.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([`POST ${MR}/unapprove`, `POST ${MR}/notes`])
    expect(api.requests[1]!.body).toEqual({ body: 'needs work' })
  })

  it('submitReview maps GitLab’s 401 on approve to FORBIDDEN', async () => {
    api.route(`POST ${MR}/approve`, () => ({ status: 401, body: { message: '401 Unauthorized' } }))
    const e = await catchErr(gl.submitReview(REPO, 7, 'approve', ''))
    expect(e.code).toBe('FORBIDDEN')
  })

  it('mergePullRequest sends squash, sha and should_remove_source_branch', async () => {
    api.route(`GET ${P}`, () => ({ body: { merge_method: 'merge', squash_option: 'default_off' } }))
    api.route(`PUT ${MR}/merge`, () => ({ body: mr(7, { state: 'merged', merge_commit_sha: null, squash_commit_sha: 'd'.repeat(40) }) }))
    const r = await gl.mergePullRequest(REPO, 7, { method: 'squash', title: 'T', message: 'M', expectedHeadSha: SHA, deleteSourceBranch: true })
    expect(r).toEqual({ merged: true, sha: 'd'.repeat(40), message: 'Merge request !7 merged.' })
    expect(api.requests[1]!.body).toEqual({ squash: true, sha: SHA, should_remove_source_branch: true, squash_commit_message: 'T\n\nM' })
    await gl.mergePullRequest(REPO, 7, { method: 'merge', title: 'Merge it' })
    expect(api.requests[3]!.body).toEqual({ squash: false, merge_commit_message: 'Merge it' })
  })

  it('mergePullRequest only allows rebase on fast-forward projects', async () => {
    api.route(`GET ${P}`, () => ({ body: { merge_method: 'merge', squash_option: 'never' } }))
    const e = await catchErr(gl.mergePullRequest(REPO, 7, { method: 'rebase' }))
    expect(e.code).toBe('INVALID_ARGUMENT')
    expect(e.message).toContain('Allowed: merge')
    expect(api.requests.some((r) => r.method === 'PUT')).toBe(false)
    api.route(`GET ${P}`, () => ({ body: { merge_method: 'ff', squash_option: 'never' } }))
    api.route(`PUT ${MR}/merge`, () => ({ body: mr(7, { state: 'merged', merge_commit_sha: null, sha: SHA }) }))
    expect(await gl.mergePullRequest(REPO, 7, { method: 'rebase' })).toMatchObject({ merged: true, sha: SHA })
    await expect(gl.mergePullRequest(REPO, 7, { method: 'merge' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('mergePullRequest maps 406/405 to CONFLICT and 409 to head-changed CONFLICT', async () => {
    api.route(`GET ${P}`, () => ({ body: { merge_method: 'merge', squash_option: 'default_off' } }))
    api.route(`PUT ${MR}/merge`, () => ({ status: 406, body: { message: 'Branch cannot be merged' } }))
    const e1 = await catchErr(gl.mergePullRequest(REPO, 7, { method: 'merge' }))
    expect(e1).toMatchObject({ code: 'CONFLICT', status: 406 })
    expect(e1.message).toContain('Branch cannot be merged')
    api.route(`PUT ${MR}/merge`, () => ({ status: 405, body: { message: '405 Method Not Allowed' } }))
    expect((await catchErr(gl.mergePullRequest(REPO, 7, { method: 'merge' }))).code).toBe('CONFLICT')
    api.route(`PUT ${MR}/merge`, () => ({ status: 409, body: { message: 'SHA does not match HEAD of source branch: 1234' } }))
    const e3 = await catchErr(gl.mergePullRequest(REPO, 7, { method: 'merge', expectedHeadSha: SHA }))
    expect(e3.code).toBe('CONFLICT')
    expect(e3.message).toMatch(/changed since it was reviewed/)
    expect(e3.message).not.toContain(TOKEN)
  })

  it('returns the merge request refspec and validates numbers', async () => {
    expect(gl.pullRequestRefspec(REPO, 12)).toBe('refs/merge-requests/12/head')
    await expect(gl.listComments(REPO, 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(gl.submitReview(REPO, 7, 'request-changes', ' ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
  })
})

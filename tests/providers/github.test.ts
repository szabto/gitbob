import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitHubAdapter } from '../../src/providers/github'
import { createAdapter } from '../../src/providers/index'
import { ProviderError, type RepoRef } from '../../src/providers/types'
import { startFakeApi, catchErr, type FakeApi } from './fakeServer'

const TOKEN = 'ghp_TESTTOKEN0123456789abcdef'
const REPO: RepoRef = {
  kind: 'github',
  host: 'github.com',
  owner: 'octo-org',
  repo: 'hello-world',
  webUrl: 'https://github.com/octo-org/hello-world',
}
const SHA = '6dcb09b5b57875f334f61aebed695e2e4193db5e'

/** Shape follows https://docs.github.com/en/rest/pulls/pulls#list-pull-requests */
function ghPull(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: `https://api.github.com/repos/octo-org/hello-world/pulls/${n}`,
    id: 1000 + n,
    node_id: `PR_${n}`,
    html_url: `https://github.com/octo-org/hello-world/pull/${n}`,
    number: n,
    state: 'open',
    locked: false,
    title: `PR ${n}`,
    user: { login: 'octocat', id: 1, type: 'User' },
    body: 'Please pull these awesome changes',
    created_at: '2011-01-26T19:01:12Z',
    updated_at: '2011-01-26T19:01:12Z',
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    draft: false,
    head: { label: 'octocat:new-topic', ref: `feature/${n}`, sha: SHA, repo: { full_name: 'octo-org/hello-world' } },
    base: { label: 'octo-org:main', ref: 'main', sha: SHA, repo: { full_name: 'octo-org/hello-world' } },
    author_association: 'MEMBER',
    ...over,
  }
}

let api: FakeApi
let gh: GitHubAdapter
beforeEach(async () => {
  api = await startFakeApi({ isAuthorized: (h) => h.authorization === `Bearer ${TOKEN}` })
  gh = new GitHubAdapter({ token: TOKEN, baseUrl: api.baseUrl, pageSize: 2 })
})
afterEach(async () => {
  await api.close()
})

describe('GitHubAdapter', () => {
  it('getUser maps login and name and sends GitHub headers', async () => {
    api.route('GET /user', () => ({ body: { login: 'octocat', id: 1, name: 'The Octocat', type: 'User' } }))
    expect(await gh.getUser()).toEqual({ login: 'octocat', name: 'The Octocat' })
    const h = api.requests[0]!.headers
    expect(h.accept).toBe('application/vnd.github+json')
    expect(h['x-github-api-version']).toBe('2022-11-28')
  })

  it('getUser maps a missing name to null', async () => {
    api.route('GET /user', () => ({ body: { login: 'ghost', name: null } }))
    expect(await gh.getUser()).toEqual({ login: 'ghost', name: null })
  })

  it('lists pull requests following Link headers for at most 3 pages', async () => {
    api.route('GET /repos/octo-org/hello-world/pulls', (req, base) => {
      const page = Number(req.query.get('page') ?? '1')
      const next = `<${base}/repos/octo-org/hello-world/pulls?state=open&per_page=2&page=${page + 1}>; rel="next"`
      const last = `<${base}/repos/octo-org/hello-world/pulls?state=open&per_page=2&page=9>; rel="last"`
      return { body: [ghPull(page * 10 + 1), ghPull(page * 10 + 2)], headers: { link: `${next}, ${last}` } }
    })
    const prs = await gh.listPullRequests(REPO, { state: 'open' })
    expect(prs.map((p) => p.number)).toEqual([11, 12, 21, 22, 31, 32])
    expect(api.requests).toHaveLength(3)
    const q = api.requests[0]!.query
    expect(q.get('state')).toBe('open')
    expect(q.get('per_page')).toBe('2')
  })

  it('stops at the limit', async () => {
    api.route('GET /repos/octo-org/hello-world/pulls', (req, base) => ({
      body: [ghPull(1), ghPull(2)],
      headers: { link: `<${base}/repos/octo-org/hello-world/pulls?page=2>; rel="next"` },
    }))
    const prs = await gh.listPullRequests(REPO, { state: 'all', limit: 3 })
    expect(prs).toHaveLength(3)
    expect(api.requests).toHaveLength(2)
    expect(api.requests[0]!.query.get('state')).toBe('all')
  })

  it('maps open, draft, merged and closed pull requests', async () => {
    api.route('GET /repos/octo-org/hello-world/pulls', () => ({
      body: [
        ghPull(1),
        ghPull(2, { draft: true }),
        ghPull(3, { state: 'closed', merged_at: '2011-02-01T00:00:00Z', closed_at: '2011-02-01T00:00:00Z' }),
        ghPull(4, { state: 'closed', closed_at: '2011-02-02T00:00:00Z', updated_at: '2011-02-02T00:00:00Z' }),
      ],
    }))
    const prs = await new GitHubAdapter({ token: TOKEN, baseUrl: api.baseUrl }).listPullRequests(REPO, { state: 'all' })
    expect(prs[0]).toEqual({
      id: 1001,
      number: 1,
      title: 'PR 1',
      author: 'octocat',
      state: 'open',
      draft: false,
      sourceBranch: 'feature/1',
      targetBranch: 'main',
      url: 'https://github.com/octo-org/hello-world/pull/1',
      createdAt: '2011-01-26T19:01:12Z',
      updatedAt: '2011-01-26T19:01:12Z',
    })
    expect(prs.map((p) => [p.state, p.draft])).toEqual([
      ['open', false],
      ['open', true],
      ['merged', false],
      ['closed', false],
    ])
    expect(prs[3]!.updatedAt).toBe('2011-02-02T00:00:00Z')
  })

  it('merges commit statuses and check runs', async () => {
    api.route(`GET /repos/octo-org/hello-world/commits/${SHA}/status`, () => ({
      body: {
        state: 'failure',
        sha: SHA,
        total_count: 2,
        statuses: [
          { state: 'success', context: 'ci/legacy', target_url: 'https://ci.example/1' },
          { state: 'error', context: 'ci/lint', target_url: 'https://ci.example/2' },
        ],
      },
    }))
    api.route(`GET /repos/octo-org/hello-world/commits/${SHA}/check-runs`, () => ({
      body: {
        total_count: 4,
        check_runs: [
          { id: 1, name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/c/1' },
          { id: 2, name: 'test', status: 'in_progress', conclusion: null, html_url: 'https://github.com/c/2' },
          { id: 3, name: 'docs', status: 'completed', conclusion: 'skipped', html_url: 'https://github.com/c/3' },
          { id: 4, name: 'e2e', status: 'queued', conclusion: null, html_url: 'https://github.com/c/4' },
        ],
      },
    }))
    expect(await gh.getChecks(REPO, SHA)).toEqual({
      state: 'failure',
      total: 6,
      failed: 1,
      pending: 2,
      url: 'https://ci.example/2',
    })
  })

  it('reports pending, success and none', async () => {
    let runs: unknown[] = []
    api.route(`GET /repos/octo-org/hello-world/commits/${SHA}/status`, () => ({
      body: { state: 'pending', total_count: 0, statuses: [] },
    }))
    api.route(`GET /repos/octo-org/hello-world/commits/${SHA}/check-runs`, () => ({
      body: { total_count: runs.length, check_runs: runs },
    }))
    expect(await gh.getChecks(REPO, SHA)).toEqual({ state: 'none', total: 0, failed: 0, pending: 0 })
    runs = [{ status: 'completed', conclusion: 'success', html_url: 'https://x/1' }]
    expect((await gh.getChecks(REPO, SHA)).state).toBe('success')
    runs = [...runs, { status: 'in_progress', conclusion: null, html_url: 'https://x/2' }]
    expect(await gh.getChecks(REPO, SHA)).toMatchObject({ state: 'pending', pending: 1, url: 'https://x/2' })
  })

  it('creates a pull request with the documented body', async () => {
    api.route('POST /repos/octo-org/hello-world/pulls', (req) => {
      const b = req.body as Record<string, unknown>
      return { status: 201, body: ghPull(42, { title: b.title, draft: b.draft, head: { ref: b.head }, base: { ref: b.base } }) }
    })
    const pr = await gh.createPullRequest(REPO, {
      title: '  Add feature  ',
      body: 'Line 1\nLine 2',
      sourceBranch: 'refs/heads/feature/x',
      targetBranch: 'main',
      draft: true,
    })
    expect(api.requests[0]!.body).toEqual({
      title: 'Add feature',
      body: 'Line 1\nLine 2',
      head: 'feature/x',
      base: 'main',
      draft: true,
    })
    expect(pr).toMatchObject({ number: 42, title: 'Add feature', draft: true, sourceBranch: 'feature/x', targetBranch: 'main' })
  })

  it('surfaces validation errors from GitHub (422)', async () => {
    api.route('POST /repos/octo-org/hello-world/pulls', () => ({
      status: 422,
      body: {
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for octo-org:x.' }],
      },
    }))
    const err = await catchErr(
      gh.createPullRequest(REPO, { title: 't', body: '', sourceBranch: 'x', targetBranch: 'main', draft: false }),
    )
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.code).toBe('BAD_RESPONSE')
    expect(err.message).toContain('A pull request already exists')
  })

  it.each([
    [{ title: '' }],
    [{ title: '   ' }],
    [{ title: 'a\nb' }],
    [{ title: 'x'.repeat(257) }],
    [{ sourceBranch: '' }],
    [{ sourceBranch: 'bad\nbranch' }],
    [{ targetBranch: '-x' }],
    [{ sourceBranch: 'main' }],
  ])('rejects invalid create input %j without a request', async (over) => {
    const input = { title: 'ok', body: '', sourceBranch: 'feat', targetBranch: 'main', draft: false, ...over }
    await expect(gh.createPullRequest(REPO, input)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
  })

  it('rejects invalid SHAs and repositories of another provider', async () => {
    await expect(gh.getChecks(REPO, 'not-a-sha')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(gh.listPullRequests({ ...REPO, kind: 'gitlab' }, { state: 'open' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(api.requests).toHaveLength(0)
  })

  it('maps errors and never leaks the token', async () => {
    const wrong = new GitHubAdapter({ token: 'ghp_WRONGTOKEN999', baseUrl: api.baseUrl })
    const e1 = await catchErr(wrong.getUser())
    expect(e1.code).toBe('UNAUTHORIZED')
    expect(e1.message).not.toContain('ghp_WRONGTOKEN999')
    const e2 = await catchErr(gh.listPullRequests(REPO, { state: 'open' }))
    expect(e2.code).toBe('NOT_FOUND')
    expect(e2.message).not.toContain(TOKEN)
  })

  it('rejects a non-array response as BAD_RESPONSE', async () => {
    api.route('GET /repos/octo-org/hello-world/pulls', () => ({ body: { message: 'weird' } }))
    await expect(gh.listPullRequests(REPO, { state: 'open' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })

  it('builds the compare URL for a branch', () => {
    expect(gh.pullRequestUrlForBranch(REPO, 'feature/a b')).toBe(
      'https://github.com/octo-org/hello-world/pull/new/feature/a%20b',
    )
  })

  it('createAdapter builds the right adapter and requires a token', () => {
    expect(createAdapter('github', { token: TOKEN }).kind).toBe('github')
    expect(createAdapter('gitlab', { token: TOKEN }).kind).toBe('gitlab')
    expect(createAdapter('bitbucket', { token: 'u:p' }).kind).toBe('bitbucket')
    expect(createAdapter('azure', { token: TOKEN }).kind).toBe('azure')
    expect(() => createAdapter('github', { token: ' ' })).toThrow(ProviderError)
  })
})

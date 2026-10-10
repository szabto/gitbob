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

describe('GitHubAdapter review & merge', () => {
  const P = '/repos/octo-org/hello-world'

  function detailRoutes(over: Record<string, unknown> = {}, repoBody: Record<string, unknown> = {}): void {
    api.route(`GET ${P}/pulls/7`, () => ({
      body: ghPull(7, {
        body: '## Summary\nDoes things',
        mergeable: true,
        mergeable_state: 'clean',
        additions: 10,
        deletions: 3,
        changed_files: 2,
        head: { ref: 'feature/7', sha: SHA, repo: { id: 1, full_name: 'octo-org/hello-world' } },
        base: { ref: 'main', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', repo: { id: 1, full_name: 'octo-org/hello-world' } },
        requested_reviewers: [{ login: 'carol' }],
        requested_teams: [{ slug: 'core' }],
        ...over,
      }),
    }))
    api.route(`GET ${P}/pulls/7/reviews`, () => ({
      body: [
        { id: 1, user: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: 'fix', submitted_at: '2024-01-01T00:00:00Z' },
        { id: 2, user: { login: 'alice' }, state: 'APPROVED', body: '', submitted_at: '2024-01-02T00:00:00Z' },
        { id: 3, user: { login: 'alice' }, state: 'COMMENTED', body: 'nit', submitted_at: '2024-01-03T00:00:00Z' },
        { id: 4, user: { login: 'bob' }, state: 'COMMENTED', body: '', submitted_at: '2024-01-03T00:00:00Z' },
        { id: 5, user: { login: 'dave' }, state: 'APPROVED', body: '', submitted_at: '2024-01-03T00:00:00Z' },
        { id: 6, user: { login: 'dave' }, state: 'DISMISSED', body: '', submitted_at: '2024-01-04T00:00:00Z' },
      ],
    }))
    api.route(`GET ${P}`, () => ({
      body: { full_name: 'octo-org/hello-world', allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false, ...repoBody },
    }))
  }

  it('getPullRequest maps detail, reviewers and allowed merge methods', async () => {
    detailRoutes()
    const d = await gh.getPullRequest(REPO, 7)
    expect(d).toMatchObject({
      number: 7,
      body: '## Summary\nDoes things',
      headSha: SHA,
      baseSha: 'a'.repeat(40),
      mergeable: 'yes',
      mergeMethods: ['merge', 'squash'],
      additions: 10,
      deletions: 3,
      changedFiles: 2,
      headRepoIsFork: false,
    })
    expect(d.reviewers).toEqual([
      { login: 'alice', state: 'approved' },
      { login: 'bob', state: 'commented' },
      { login: 'dave', state: 'commented' },
      { login: 'carol', state: 'pending' },
      { login: 'team:core', state: 'pending' },
    ])
  })

  it.each([
    [{ mergeable: null, mergeable_state: 'unknown' }, 'unknown'],
    [{ mergeable: false, mergeable_state: 'dirty' }, 'conflicts'],
    [{ mergeable: true, mergeable_state: 'blocked' }, 'no'],
    [{ mergeable: true, mergeable_state: 'unstable' }, 'yes'],
    [{ draft: true }, 'no'],
    [{ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }, 'no'],
  ])('maps mergeability %j → %s', async (over, expected) => {
    detailRoutes(over)
    expect((await gh.getPullRequest(REPO, 7)).mergeable).toBe(expected)
  })

  it('detects forks (including deleted forks) and falls back to all methods without push access', async () => {
    detailRoutes({ head: { ref: 'patch-1', sha: SHA, repo: { id: 99, full_name: 'stranger/hello-world' } } }, {
      allow_merge_commit: undefined,
      allow_squash_merge: undefined,
      allow_rebase_merge: undefined,
    })
    const d = await gh.getPullRequest(REPO, 7)
    expect(d.headRepoIsFork).toBe(true)
    expect(d.mergeMethods).toEqual(['merge', 'squash', 'rebase'])
    detailRoutes({ head: { ref: 'patch-1', sha: SHA, repo: null } })
    expect((await gh.getPullRequest(REPO, 7)).headRepoIsFork).toBe(true)
  })

  it('listComments merges issue, inline and review comments across pages, oldest first', async () => {
    api.route(`GET ${P}/issues/7/comments`, (req, base) => {
      const page = Number(req.query.get('page') ?? '1')
      const headers: Record<string, string> =
        page < 3 ? { link: `<${base}${P}/issues/7/comments?per_page=2&page=${page + 1}>; rel="next"` } : {}
      return {
        headers,
        body: [
          { id: page * 10 + 1, user: { login: 'u' }, body: `c${page}a`, created_at: `2024-01-0${page}T01:00:00Z` },
          { id: page * 10 + 2, user: { login: 'u' }, body: `c${page}b`, created_at: `2024-01-0${page}T02:00:00Z` },
        ],
      }
    })
    api.route(`GET ${P}/pulls/7/comments`, () => ({
      body: [
        { id: 500, user: { login: 'r' }, body: 'inline', created_at: '2024-01-01T01:30:00Z', path: 'src/a.ts', line: 12 },
        { id: 501, user: { login: 'r' }, body: 'outdated', created_at: '2024-01-04T00:00:00Z', path: 'src/b.ts', line: null, original_line: 4 },
      ],
    }))
    api.route(`GET ${P}/pulls/7/reviews`, () => ({
      body: [
        { id: 900, user: { login: 'alice' }, state: 'APPROVED', body: 'LGTM', submitted_at: '2024-01-05T00:00:00Z' },
        { id: 901, user: { login: 'bob' }, state: 'COMMENTED', body: '', submitted_at: '2024-01-05T00:00:00Z' },
      ],
    }))
    const comments = await gh.listComments(REPO, 7)
    expect(api.requests.filter((r) => r.pathname.endsWith('/issues/7/comments'))).toHaveLength(3)
    expect(comments.map((c) => c.id)).toEqual([
      'issue:11',
      'review-comment:500',
      'issue:12',
      'issue:21',
      'issue:22',
      'issue:31',
      'issue:32',
      'review-comment:501',
      'review:900',
    ])
    expect(comments[1]).toEqual({ id: 'review-comment:500', author: 'r', body: 'inline', createdAt: '2024-01-01T01:30:00Z', path: 'src/a.ts', line: 12 })
    expect(comments.find((c) => c.id === 'review-comment:501')!.line).toBe(4)
  })

  it('addComment posts an issue comment', async () => {
    api.route(`POST ${P}/issues/7/comments`, (req) => ({
      status: 201,
      body: { id: 77, user: { login: 'octocat' }, body: (req.body as { body: string }).body, created_at: '2024-02-01T00:00:00Z' },
    }))
    expect(await gh.addComment(REPO, 7, 'Thanks!')).toEqual({ id: 'issue:77', author: 'octocat', body: 'Thanks!', createdAt: '2024-02-01T00:00:00Z' })
    expect(api.requests[0]!.body).toEqual({ body: 'Thanks!' })
  })

  it('submitReview sends APPROVE / COMMENT / REQUEST_CHANGES', async () => {
    api.route(`POST ${P}/pulls/7/reviews`, () => ({ body: { id: 1, state: 'APPROVED' } }))
    await gh.submitReview(REPO, 7, 'approve', '')
    await gh.submitReview(REPO, 7, 'comment', 'Looks fine')
    await gh.submitReview(REPO, 7, 'request-changes', 'Please add tests')
    expect(api.requests.map((r) => r.body)).toEqual([
      { event: 'APPROVE' },
      { event: 'COMMENT', body: 'Looks fine' },
      { event: 'REQUEST_CHANGES', body: 'Please add tests' },
    ])
  })

  it('submitReview validates locally and maps 422', async () => {
    await expect(gh.submitReview(REPO, 7, 'comment', '  ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(gh.submitReview(REPO, 7, 'request-changes', '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(gh.submitReview(REPO, 7, 'bogus' as never, 'x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
    api.route(`POST ${P}/pulls/7/reviews`, () => ({
      status: 422,
      body: { message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] },
    }))
    const e = await catchErr(gh.submitReview(REPO, 7, 'approve', ''))
    expect(e.code).toBe('INVALID_ARGUMENT')
    expect(e.message).toContain('Can not approve your own pull request')
  })

  it('mergePullRequest sends method, sha and commit text', async () => {
    api.route(`PUT ${P}/pulls/7/merge`, () => ({ body: { sha: 'b'.repeat(40), merged: true, message: 'Pull Request successfully merged' } }))
    const r = await gh.mergePullRequest(REPO, 7, { method: 'squash', title: 'Feature (#7)', message: 'details', expectedHeadSha: SHA })
    expect(r).toEqual({ merged: true, sha: 'b'.repeat(40), message: 'Pull Request successfully merged' })
    expect(api.requests[0]!.body).toEqual({ merge_method: 'squash', sha: SHA, commit_title: 'Feature (#7)', commit_message: 'details' })
    await gh.mergePullRequest(REPO, 7, { method: 'rebase', title: 'ignored' })
    expect(api.requests[1]!.body).toEqual({ merge_method: 'rebase' })
  })

  it('mergePullRequest maps 405 (not mergeable) and 409 (head changed) to CONFLICT', async () => {
    api.route(`PUT ${P}/pulls/7/merge`, () => ({ status: 405, body: { message: 'Pull Request is not mergeable' } }))
    const e1 = await catchErr(gh.mergePullRequest(REPO, 7, { method: 'merge' }))
    expect(e1.code).toBe('CONFLICT')
    expect(e1.message).toContain('Pull Request is not mergeable')
    expect(e1.message).not.toContain(TOKEN)
    api.route(`PUT ${P}/pulls/7/merge`, () => ({ status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } }))
    const e2 = await catchErr(gh.mergePullRequest(REPO, 7, { method: 'merge', expectedHeadSha: SHA }))
    expect(e2.code).toBe('CONFLICT')
    expect(e2.status).toBe(409)
    expect(e2.message).toMatch(/changed since it was reviewed/)
  })

  it('mergePullRequest deletes the head branch only for same-repository pull requests', async () => {
    detailRoutes()
    api.route(`PUT ${P}/pulls/7/merge`, () => ({ body: { sha: 'c'.repeat(40), merged: true, message: 'merged' } }))
    api.route(`DELETE ${P}/git/refs/heads/feature/7`, () => ({ status: 204 }))
    const r = await gh.mergePullRequest(REPO, 7, { method: 'merge', deleteSourceBranch: true })
    expect(r.message).toContain('Deleted branch feature/7')
    expect(api.requests.some((q) => q.method === 'DELETE' && q.pathname === `${P}/git/refs/heads/feature/7`)).toBe(true)

    api.requests.length = 0
    detailRoutes({ head: { ref: 'feature/7', sha: SHA, repo: { id: 99, full_name: 'fork/hello-world' } } })
    const r2 = await gh.mergePullRequest(REPO, 7, { method: 'merge', deleteSourceBranch: true })
    expect(r2.merged).toBe(true)
    expect(r2.message).toContain('fork')
    expect(api.requests.some((q) => q.method === 'DELETE')).toBe(false)
  })

  it.each([
    [{ method: 'octopus' }],
    [{ method: 'merge', expectedHeadSha: 'zzz' }],
    [{ method: 'merge', title: 'a\nb' }],
    [{ method: 'merge', message: 'x'.repeat(65_537) }],
  ])('mergePullRequest rejects %j without a request', async (opts) => {
    await expect(gh.mergePullRequest(REPO, 7, opts as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
  })

  it('validates numbers and bodies, and returns the PR refspec', async () => {
    for (const n of [0, -1, 1.5, Number.NaN]) {
      await expect(gh.getPullRequest(REPO, n)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(gh.addComment(REPO, 7, '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(gh.addComment(REPO, 7, 'x'.repeat(65_537))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests).toHaveLength(0)
    expect(gh.pullRequestRefspec(REPO, 7)).toBe('refs/pull/7/head')
    expect(() => gh.pullRequestRefspec(REPO, 0)).toThrow(ProviderError)
  })
})

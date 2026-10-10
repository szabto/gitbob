import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BitbucketAdapter } from '../../src/providers/bitbucket'
import type { RepoRef } from '../../src/providers/types'
import { basic, startFakeApi, catchErr, type FakeApi } from './fakeServer'

const USER = 'jdoe'
const SECRET = 'ATBB_testapppassword123'
const TOKEN = `${USER}:${SECRET}`
const REPO: RepoRef = {
  kind: 'bitbucket',
  host: 'bitbucket.org',
  owner: 'acme',
  repo: 'widgets',
  webUrl: 'https://bitbucket.org/acme/widgets',
}
const R = '/2.0/repositories/acme/widgets'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** Shape follows https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/ */
function bbPull(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'pullrequest',
    id,
    title: `PR ${id}`,
    description: 'desc',
    state: 'OPEN',
    draft: false,
    author: { type: 'user', display_name: 'Jane Doe', nickname: 'jane', uuid: '{1}', account_id: '5b10a' },
    source: { branch: { name: `feature/${id}` }, commit: { hash: SHA.slice(0, 12) }, repository: { full_name: 'acme/widgets' } },
    destination: { branch: { name: 'main' }, commit: { hash: SHA.slice(0, 12) }, repository: { full_name: 'acme/widgets' } },
    created_on: '2024-05-01T12:00:00.000000+00:00',
    updated_on: '2024-05-02T12:00:00.000000+00:00',
    comment_count: 0,
    task_count: 0,
    links: {
      self: { href: `https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/${id}` },
      html: { href: `https://bitbucket.org/acme/widgets/pull-requests/${id}` },
    },
    ...over,
  }
}

let api: FakeApi
let bb: BitbucketAdapter
beforeEach(async () => {
  api = await startFakeApi({
    prefix: '/2.0',
    isAuthorized: (h) => h.authorization === basic(USER, SECRET) || h.authorization === 'Bearer REPO_ACCESS_TOKEN',
  })
  bb = new BitbucketAdapter({ token: TOKEN, baseUrl: api.baseUrl, pageSize: 2 })
})
afterEach(async () => {
  await api.close()
})

describe('BitbucketAdapter', () => {
  it('getUser uses Basic username:token and maps nickname', async () => {
    api.route('GET /2.0/user', () => ({
      body: { type: 'user', display_name: 'Jane Doe', nickname: 'jane', account_id: '5b10a', uuid: '{1}' },
    }))
    expect(await bb.getUser()).toEqual({ login: 'jane', name: 'Jane Doe' })
  })

  it('uses Bearer for bare access tokens', async () => {
    api.route(`GET ${R}/pullrequests`, () => ({ body: { pagelen: 50, size: 0, page: 1, values: [] } }))
    const tokenAdapter = new BitbucketAdapter({ token: 'REPO_ACCESS_TOKEN', baseUrl: api.baseUrl })
    expect(await tokenAdapter.listPullRequests(REPO, { state: 'open' })).toEqual([])
    expect(api.requests[0]!.headers.authorization).toBe('Bearer REPO_ACCESS_TOKEN')
  })

  it('follows body `next` links for at most 3 pages', async () => {
    api.route(`GET ${R}/pullrequests`, (req, base) => {
      const page = Number(req.query.get('page') ?? '1')
      return {
        body: {
          pagelen: 2,
          size: 10,
          page,
          values: [bbPull(page * 10 + 1), bbPull(page * 10 + 2)],
          next: `${base}/repositories/acme/widgets/pullrequests?state=OPEN&pagelen=2&page=${page + 1}`,
        },
      }
    })
    const prs = await bb.listPullRequests(REPO, { state: 'open' })
    expect(prs.map((p) => p.number)).toEqual([11, 12, 21, 22, 31, 32])
    expect(api.requests).toHaveLength(3)
    expect(api.requests[0]!.query.getAll('state')).toEqual(['OPEN'])
    expect(api.requests[0]!.query.get('pagelen')).toBe('2')
  })

  it('requests every state for "all" and maps states', async () => {
    api.route(`GET ${R}/pullrequests`, () => ({
      body: {
        values: [
          bbPull(1),
          bbPull(2, { draft: true }),
          bbPull(3, { state: 'MERGED' }),
          bbPull(4, { state: 'DECLINED' }),
          bbPull(5, { state: 'SUPERSEDED' }),
        ],
      },
    }))
    const prs = await new BitbucketAdapter({ token: TOKEN, baseUrl: api.baseUrl }).listPullRequests(REPO, { state: 'all' })
    expect(api.requests[0]!.query.getAll('state')).toEqual(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'])
    expect(api.requests[0]!.query.get('pagelen')).toBe('50')
    expect(prs[0]).toEqual({
      id: 1,
      number: 1,
      title: 'PR 1',
      author: 'jane',
      state: 'open',
      draft: false,
      sourceBranch: 'feature/1',
      targetBranch: 'main',
      url: 'https://bitbucket.org/acme/widgets/pull-requests/1',
      createdAt: '2024-05-01T12:00:00.000000+00:00',
      updatedAt: '2024-05-02T12:00:00.000000+00:00',
    })
    expect(prs.map((p) => [p.state, p.draft])).toEqual([
      ['open', false],
      ['open', true],
      ['merged', false],
      ['closed', false],
      ['closed', false],
    ])
  })

  it('summarises commit build statuses', async () => {
    api.route(`GET ${R}/commit/${SHA}/statuses`, () => ({
      body: {
        pagelen: 100,
        page: 1,
        size: 3,
        values: [
          { type: 'build', key: 'pipeline', state: 'SUCCESSFUL', url: 'https://ci/1', name: 'Pipeline #1' },
          { type: 'build', key: 'jenkins', state: 'INPROGRESS', url: 'https://ci/2', name: 'Jenkins' },
          { type: 'build', key: 'old', state: 'STOPPED', url: 'https://ci/3', name: 'Old' },
        ],
      },
    }))
    expect(await bb.getChecks(REPO, SHA)).toEqual({ state: 'failure', total: 3, failed: 1, pending: 1, url: 'https://ci/3' })
  })

  it('creates a pull request with the documented body', async () => {
    api.route(`POST ${R}/pullrequests`, (req) => {
      const b = req.body as { title: string; draft: boolean; source: { branch: { name: string } } }
      return { status: 201, body: bbPull(9, { title: b.title, draft: b.draft, source: { branch: { name: b.source.branch.name } } }) }
    })
    const pr = await bb.createPullRequest(REPO, {
      title: 'Fix bug',
      body: 'Details',
      sourceBranch: 'bugfix/1',
      targetBranch: 'main',
      draft: false,
    })
    expect(api.requests[0]!.body).toEqual({
      title: 'Fix bug',
      description: 'Details',
      source: { branch: { name: 'bugfix/1' } },
      destination: { branch: { name: 'main' } },
      draft: false,
    })
    expect(pr).toMatchObject({ number: 9, title: 'Fix bug', sourceBranch: 'bugfix/1', state: 'open' })
  })

  it('maps Bitbucket error payloads and redacts both parts of the credential', async () => {
    api.route(`POST ${R}/pullrequests`, () => ({
      status: 400,
      body: { type: 'error', error: { message: `There are no changes to be pulled (${SECRET})` } },
    }))
    const err = await catchErr(
      bb.createPullRequest(REPO, { title: 't', body: '', sourceBranch: 'a', targetBranch: 'main', draft: false }),
    )
    expect(err.code).toBe('BAD_RESPONSE')
    expect(err.message).toContain('There are no changes')
    expect(err.message).not.toContain(SECRET)

    const wrong = new BitbucketAdapter({ token: 'jdoe:wrongpassword', baseUrl: api.baseUrl })
    const e = await catchErr(wrong.getUser())
    expect(e.code).toBe('UNAUTHORIZED')
    expect(e.message).not.toContain('wrongpassword')
  })

  it('builds the new pull request URL', () => {
    expect(bb.pullRequestUrlForBranch(REPO, 'feature/x')).toBe(
      'https://bitbucket.org/acme/widgets/pull-requests/new?source=feature%2Fx&t=1',
    )
  })
})

describe('BitbucketAdapter review & merge', () => {
  const PR = `${R}/pullrequests/7`
  const HEAD12 = SHA.slice(0, 12)

  function detailRoutes(over: Record<string, unknown> = {}, diffstat: unknown[] | null = null): void {
    api.route(`GET ${PR}`, () => ({
      body: bbPull(7, {
        description: 'PR body',
        destination: {
          branch: { name: 'main', merge_strategies: ['merge_commit', 'squash', 'fast_forward'], default_merge_strategy: 'merge_commit' },
          commit: { hash: 'aaaaaaaaaaaa' },
          repository: { full_name: 'acme/widgets' },
        },
        reviewers: [{ nickname: 'rev1' }, { nickname: 'rev2' }],
        participants: [
          { role: 'REVIEWER', approved: true, state: 'approved', user: { nickname: 'rev1' } },
          { role: 'REVIEWER', approved: false, state: null, user: { nickname: 'rev2' } },
          { role: 'PARTICIPANT', approved: false, state: 'changes_requested', user: { nickname: 'pat' } },
          { role: 'PARTICIPANT', approved: false, state: null, user: { display_name: 'Chatty Person' } },
        ],
        ...over,
      }),
    }))
    api.route(`GET ${PR}/diffstat`, () =>
      diffstat === null
        ? { status: 500, body: { error: { message: 'boom' } } }
        : { body: { pagelen: 500, values: diffstat } },
    )
  }

  it('getPullRequest maps detail, participants and diffstat totals', async () => {
    detailRoutes({}, [
      { status: 'modified', lines_added: 5, lines_removed: 2 },
      { status: 'added', lines_added: 10, lines_removed: 0 },
    ])
    expect(await bb.getPullRequest(REPO, 7)).toMatchObject({
      number: 7,
      body: 'PR body',
      baseSha: 'aaaaaaaaaaaa',
      headSha: HEAD12,
      mergeable: 'yes',
      mergeMethods: ['merge', 'squash', 'rebase'],
      reviewers: [
        { login: 'rev1', state: 'approved' },
        { login: 'rev2', state: 'pending' },
        { login: 'pat', state: 'changes-requested' },
        { login: 'Chatty Person', state: 'commented' },
      ],
      additions: 15,
      deletions: 2,
      changedFiles: 2,
      headRepoIsFork: false,
    })
  })

  it('reports conflicts from the diffstat, unknown when it fails, and forks', async () => {
    detailRoutes({}, [{ status: 'merge conflict', lines_added: 1, lines_removed: 1 }])
    expect((await bb.getPullRequest(REPO, 7)).mergeable).toBe('conflicts')
    detailRoutes({ source: { branch: { name: 'f' }, commit: { hash: HEAD12 }, repository: { full_name: 'someone/widgets' } } }, null)
    const d = await bb.getPullRequest(REPO, 7)
    expect(d).toMatchObject({ mergeable: 'unknown', additions: null, changedFiles: null, headRepoIsFork: true })
    detailRoutes({ state: 'DECLINED' }, [])
    expect((await bb.getPullRequest(REPO, 7)).mergeable).toBe('no')
  })

  it('listComments follows next links (max 3 pages) and skips deleted comments', async () => {
    api.route(`GET ${PR}/comments`, (req, base) => {
      const page = Number(req.query.get('page') ?? '1')
      return {
        body: {
          pagelen: 2,
          next: `${base}/repositories/acme/widgets/pullrequests/7/comments?page=${page + 1}`,
          values: [
            { id: page * 10 + 1, deleted: false, content: { raw: `c${page}` }, user: { nickname: 'jane' }, created_on: `2024-05-0${page}T00:00:00+00:00` },
            {
              id: page * 10 + 2,
              deleted: page === 1,
              content: { raw: `inline${page}` },
              user: { nickname: 'joe' },
              created_on: `2024-05-0${page}T01:00:00+00:00`,
              inline: { path: 'src/x.py', from: null, to: 3 },
            },
          ],
        },
      }
    })
    const c = await bb.listComments(REPO, 7)
    expect(api.requests).toHaveLength(3)
    expect(c.map((x) => x.id)).toEqual(['11', '21', '22', '31', '32'])
    expect(c[2]).toEqual({ id: '22', author: 'joe', body: 'inline2', createdAt: '2024-05-02T01:00:00+00:00', path: 'src/x.py', line: 3 })
  })

  it('addComment posts content.raw', async () => {
    api.route(`POST ${PR}/comments`, (req) => ({
      status: 201,
      body: { id: 5, content: { raw: (req.body as { content: { raw: string } }).content.raw }, user: { nickname: 'jane' }, created_on: '2024-06-01' },
    }))
    expect(await bb.addComment(REPO, 7, 'hi')).toEqual({ id: '5', author: 'jane', body: 'hi', createdAt: '2024-06-01' })
    expect(api.requests[0]!.body).toEqual({ content: { raw: 'hi' } })
  })

  it('submitReview uses /approve, /request-changes and comments', async () => {
    api.route(`POST ${PR}/approve`, () => ({ body: { approved: true } }))
    api.route(`POST ${PR}/request-changes`, () => ({ body: { state: 'changes_requested' } }))
    api.route(`POST ${PR}/comments`, () => ({ status: 201, body: { id: 1, content: { raw: '' } } }))
    await bb.submitReview(REPO, 7, 'approve', '')
    await bb.submitReview(REPO, 7, 'request-changes', 'please fix')
    await bb.submitReview(REPO, 7, 'comment', 'fyi')
    expect(api.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      `POST ${PR}/approve`,
      `POST ${PR}/request-changes`,
      `POST ${PR}/comments`,
      `POST ${PR}/comments`,
    ])
    expect(api.requests[2]!.body).toEqual({ content: { raw: 'please fix' } })
    api.route(`POST ${PR}/approve`, () => ({ status: 400, body: { type: 'error', error: { message: "You can't approve your own pull request." } } }))
    const e = await catchErr(bb.submitReview(REPO, 7, 'approve', ''))
    expect(e.code).toBe('INVALID_ARGUMENT')
    expect(e.message).toContain("can't approve")
  })

  it('mergePullRequest checks the expected head, maps strategies and close_source_branch', async () => {
    detailRoutes()
    api.route(`POST ${PR}/merge`, () => ({ body: bbPull(7, { state: 'MERGED', merge_commit: { hash: 'e'.repeat(40) } }) }))
    const r = await bb.mergePullRequest(REPO, 7, { method: 'squash', title: 'T', message: 'M', expectedHeadSha: SHA, deleteSourceBranch: true })
    expect(r).toEqual({ merged: true, sha: 'e'.repeat(40), message: 'Pull request #7 merged.' })
    const merges = (): unknown[] => api.requests.filter((q) => q.method === 'POST').map((q) => q.body)
    expect(merges()[0]).toEqual({ type: 'pullrequest_merge_parameters', merge_strategy: 'squash', close_source_branch: true, message: 'T\n\nM' })
    await bb.mergePullRequest(REPO, 7, { method: 'rebase', title: 'ignored' })
    expect(merges()[1]).toEqual({ type: 'pullrequest_merge_parameters', merge_strategy: 'fast_forward', close_source_branch: false })
    await bb.mergePullRequest(REPO, 7, { method: 'merge' })
    expect((merges()[2] as Record<string, unknown>).merge_strategy).toBe('merge_commit')
  })

  it('mergePullRequest refuses when the head moved or the strategy is not offered', async () => {
    detailRoutes()
    api.route(`POST ${PR}/merge`, () => ({ body: bbPull(7, { state: 'MERGED' }) }))
    const e = await catchErr(bb.mergePullRequest(REPO, 7, { method: 'merge', expectedHeadSha: 'f'.repeat(40) }))
    expect(e.code).toBe('CONFLICT')
    expect(e.message).toMatch(/changed since it was reviewed/)
    detailRoutes({
      destination: { branch: { name: 'main', merge_strategies: ['squash'] }, commit: { hash: 'aaaaaaaaaaaa' }, repository: { full_name: 'acme/widgets' } },
    })
    await expect(bb.mergePullRequest(REPO, 7, { method: 'merge' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(api.requests.some((q) => q.method === 'POST')).toBe(false)
  })

  it('mergePullRequest maps 400 conflicts to CONFLICT and 202 to in-progress', async () => {
    detailRoutes()
    api.route(`POST ${PR}/merge`, () => ({ status: 400, body: { type: 'error', error: { message: 'You can’t merge until you resolve all merge conflicts.' } } }))
    const e = await catchErr(bb.mergePullRequest(REPO, 7, { method: 'merge' }))
    expect(e.code).toBe('CONFLICT')
    expect(e.message).toContain('resolve all merge conflicts')
    expect(e.message).not.toContain(SECRET)
    api.route(`POST ${PR}/merge`, () => ({ status: 202, headers: { location: 'https://api.bitbucket.org/2.0/x/task-status/1' }, body: { task_status: 'PENDING' } }))
    expect(await bb.mergePullRequest(REPO, 7, { method: 'merge' })).toMatchObject({ merged: false, sha: null })
  })

  it('has no pull request refspec', () => {
    expect(bb.pullRequestRefspec(REPO, 7)).toBeNull()
  })
})

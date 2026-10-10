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

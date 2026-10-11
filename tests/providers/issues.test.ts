import { afterEach, describe, expect, it } from 'vitest'
import { BitbucketAdapter } from '../../src/providers/bitbucket'
import { GitHubAdapter } from '../../src/providers/github'
import { GitLabAdapter } from '../../src/providers/gitlab'
import type { RepoRef } from '../../src/providers/types'
import { basic, startFakeApi, type FakeApi } from './fakeServer'

let api: FakeApi | null = null
afterEach(async () => {
  await api?.close()
  api = null
})
const ref = (kind: RepoRef['kind']): RepoRef => ({ kind, host: 'x', owner: 'acme', repo: 'widgets', webUrl: 'https://x/acme/widgets' })

describe('listIssues', () => {
  it('GitHub: open issues without the pull requests GitHub mixes in', async () => {
    api = await startFakeApi({ isAuthorized: (h) => h.authorization === 'Bearer t' })
    api.route('GET /repos/acme/widgets/issues', () => ({
      body: [
        { number: 3, title: 'Crash on start', user: { login: 'ann' }, html_url: 'https://github.com/acme/widgets/issues/3', labels: [{ name: 'bug' }], comments: 2, updated_at: '2026-10-01' },
        { number: 4, title: 'A PR', user: { login: 'bo' }, html_url: 'https://github.com/acme/widgets/pull/4', labels: [], pull_request: {}, updated_at: '2026-10-02' },
        { number: 5, title: 'Bad link', user: { login: 'eve' }, html_url: 'javascript:alert(1)', labels: [], updated_at: '2026-10-03' },
      ],
    }))
    const issues = await new GitHubAdapter({ token: 't', baseUrl: api.baseUrl }).listIssues(ref('github'))
    expect(issues.map((i) => [i.number, i.title, i.labels, i.comments])).toEqual([
      [3, 'Crash on start', ['bug'], 2],
      [5, 'Bad link', [], 0],
    ])
    expect(issues[1]!.url).toBe('') // unsafe link dropped
    expect(api.requests[0]!.query.get('state')).toBe('open')
  })

  it('GitLab: opened issues by iid', async () => {
    api = await startFakeApi({ prefix: '/api/v4', isAuthorized: (h) => h['private-token'] === 't' })
    api.route('GET /api/v4/projects/acme%2Fwidgets/issues', () => ({
      body: [{ iid: 7, title: 'Slow', author: { username: 'ann' }, web_url: 'https://gitlab.com/acme/widgets/-/issues/7', labels: ['perf'], user_notes_count: 1, updated_at: 'x' }],
    }))
    const issues = await new GitLabAdapter({ token: 't', baseUrl: api.baseUrl }).listIssues(ref('gitlab'))
    expect(issues).toEqual([{ number: 7, title: 'Slow', author: 'ann', url: 'https://gitlab.com/acme/widgets/-/issues/7', labels: ['perf'], comments: 1, updatedAt: 'x' }])
  })

  it('Bitbucket: new and open issues', async () => {
    api = await startFakeApi({ isAuthorized: (h) => h.authorization === basic('me', 'pw') })
    api.route('GET /repositories/acme/widgets/issues', (req) => {
      expect(req.query.get('q')).toBe('state="new" OR state="open"')
      return { body: { values: [{ id: 2, title: 'Typo', reporter: { nickname: 'bo' }, links: { html: { href: 'https://bitbucket.org/acme/widgets/issues/2' } }, kind: 'bug', priority: 'minor', updated_on: 'y' }] } }
    })
    const issues = await new BitbucketAdapter({ token: 'me:pw', baseUrl: api.baseUrl }).listIssues(ref('bitbucket'))
    expect(issues.map((i) => [i.number, i.author, i.labels])).toEqual([[2, 'bo', ['bug', 'minor']]])
  })
})

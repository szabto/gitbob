import { afterEach, describe, expect, it } from 'vitest'
import { AzureDevOpsAdapter } from '../../src/providers/azure'
import { BitbucketAdapter } from '../../src/providers/bitbucket'
import { GitHubAdapter } from '../../src/providers/github'
import { GitLabAdapter } from '../../src/providers/gitlab'
import { ProviderError, type RepoRef } from '../../src/providers/types'
import { basic, catchErr, startFakeApi, type FakeApi } from './fakeServer'

const SHA = 'a'.repeat(40)
let api: FakeApi | null = null
afterEach(async () => {
  await api?.close()
  api = null
})
const ref = (kind: RepoRef['kind'], extra: Partial<RepoRef> = {}): RepoRef => ({ kind, host: 'x', owner: 'acme', repo: 'widgets', webUrl: 'https://x/acme/widgets', ...extra })

describe('addLineComment', () => {
  it('GitHub posts a review comment on the right or left side of the diff', async () => {
    api = await startFakeApi({ isAuthorized: (h) => h.authorization === 'Bearer t' })
    api.route('POST /repos/acme/widgets/pulls/7/comments', (req) => ({
      status: 201,
      body: { id: 5, user: { login: 'me' }, body: (req.body as { body: string }).body, created_at: 'now', path: 'src/a.ts', line: 3, side: (req.body as { side: string }).side },
    }))
    const gh = new GitHubAdapter({ token: 't', baseUrl: api.baseUrl })
    const c = await gh.addLineComment(ref('github'), 7, { path: 'src/a.ts', line: 3, side: 'old', body: 'why?', headSha: SHA })
    expect(api.requests[0]!.body).toEqual({ body: 'why?', commit_id: SHA, path: 'src/a.ts', line: 3, side: 'LEFT' })
    expect(c).toMatchObject({ path: 'src/a.ts', line: 3, side: 'old', body: 'why?' })
    await gh.addLineComment(ref('github'), 7, { path: 'src/a.ts', line: 3, side: 'new', body: 'ok', headSha: SHA })
    expect((api.requests[1]!.body as { side: string }).side).toBe('RIGHT')
  })

  it('GitLab positions a discussion with diff_refs and refuses a stale head', async () => {
    api = await startFakeApi({ prefix: '/api/v4', isAuthorized: (h) => h['private-token'] === 't' })
    let head = SHA
    api.route('GET /api/v4/projects/acme%2Fwidgets/merge_requests/7', () => ({ body: { diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: head } } }))
    api.route('POST /api/v4/projects/acme%2Fwidgets/merge_requests/7/discussions', (req) => ({
      status: 201,
      body: { notes: [{ id: 9, author: { username: 'me' }, body: 'hm', created_at: 'now', position: (req.body as { position: unknown }).position }] },
    }))
    const gl = new GitLabAdapter({ token: 't', baseUrl: api.baseUrl })
    const c = await gl.addLineComment(ref('gitlab'), 7, { path: 'new.ts', oldPath: 'old.ts', line: 4, side: 'new', body: 'hm', headSha: SHA })
    expect((api.requests[1]!.body as { position: unknown }).position).toEqual({
      position_type: 'text', base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: SHA, old_path: 'old.ts', new_path: 'new.ts', new_line: 4,
    })
    expect(c).toMatchObject({ path: 'new.ts', line: 4 })
    head = 'd'.repeat(40)
    const err = await catchErr(gl.addLineComment(ref('gitlab'), 7, { path: 'new.ts', line: 4, side: 'new', body: 'hm', headSha: SHA }))
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).code).toBe('CONFLICT')
  })

  it('Bitbucket uses inline.to for new lines and inline.from for removed lines', async () => {
    api = await startFakeApi({ isAuthorized: (h) => h.authorization === basic('me', 'pw') })
    api.route('POST /repositories/acme/widgets/pullrequests/7/comments', (req) => ({
      status: 201,
      body: { id: 3, user: { nickname: 'me' }, content: { raw: 'x' }, created_on: 'now', inline: (req.body as { inline: unknown }).inline },
    }))
    const bb = new BitbucketAdapter({ token: 'me:pw', baseUrl: api.baseUrl })
    const c = await bb.addLineComment(ref('bitbucket'), 7, { path: 'a.ts', line: 2, side: 'old', body: 'x', headSha: SHA })
    expect((api.requests[0]!.body as { inline: unknown }).inline).toEqual({ path: 'a.ts', from: 2 })
    expect(c).toMatchObject({ path: 'a.ts', line: 2, side: 'old' })
  })

  it('Azure DevOps creates a thread with a right or left file context', async () => {
    api = await startFakeApi({ isAuthorized: (h) => h.authorization === basic('', 'pat') })
    api.route('POST /acme/Web/_apis/git/repositories/widgets/pullRequests/7/threads', (req) => ({
      body: { id: 4, threadContext: (req.body as { threadContext: unknown }).threadContext, comments: [{ id: 1, content: 'y', author: { uniqueName: 'me' }, publishedDate: 'now', commentType: 1 }] },
    }))
    const az = new AzureDevOpsAdapter({ token: 'pat', baseUrl: api.baseUrl, profileBaseUrl: api.baseUrl })
    const c = await az.addLineComment(ref('azure', { project: 'Web' }), 7, { path: 'src/a.ts', line: 8, side: 'new', body: 'y', headSha: SHA })
    expect((api.requests[0]!.body as { threadContext: unknown }).threadContext).toEqual({
      filePath: '/src/a.ts', rightFileStart: { line: 8, offset: 1 }, rightFileEnd: { line: 8, offset: 1 },
    })
    expect(c).toMatchObject({ path: 'src/a.ts', line: 8 })
  })

  it('rejects paths outside the repository, bad lines and empty bodies before any request', async () => {
    api = await startFakeApi({ isAuthorized: () => true })
    const gh = new GitHubAdapter({ token: 't', baseUrl: api.baseUrl })
    const bad = [
      { path: '../etc/passwd', line: 1, side: 'new', body: 'x', headSha: SHA },
      { path: '/abs', line: 1, side: 'new', body: 'x', headSha: SHA },
      { path: 'a', line: 0, side: 'new', body: 'x', headSha: SHA },
      { path: 'a', line: 1, side: 'up', body: 'x', headSha: SHA },
      { path: 'a', line: 1, side: 'new', body: '  ', headSha: SHA },
      { path: 'a', line: 1, side: 'new', body: 'x', headSha: 'zz' },
    ] as const
    for (const input of bad) {
      expect(((await catchErr(gh.addLineComment(ref('github'), 7, input as never))) as ProviderError).code).toBe('INVALID_ARGUMENT')
    }
    expect(api.requests).toHaveLength(0)
  })
})

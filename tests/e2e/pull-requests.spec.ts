import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')
const TOKEN = 'gho_test_oauth_token_1'

interface Recorded {
  method: string
  path: string
  body: unknown
}

/** Fake GitHub REST + OAuth device flow endpoints for one pull request. */
async function fakeGitHub(pr: { head: string; base: string }) {
  const requests: Recorded[] = []
  let polls = 0
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((r) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => r(b))
    })
  const prJson = {
    id: 9012, number: 12, title: 'Add login form', state: 'open', draft: false, merged_at: null,
    body: 'Adds the login form.\n\nCloses #3.', user: { login: 'kenji' },
    head: { ref: 'feature/login', sha: pr.head, repo: { id: 1 } }, base: { ref: 'main', sha: pr.base, repo: { id: 1 } },
    html_url: 'https://github.com/acme/widgets/pull/12', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-02T10:00:00Z',
    mergeable: true, mergeable_state: 'clean', additions: 2, deletions: 1, changed_files: 2, requested_reviewers: [], requested_teams: [],
  }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const raw = await readBody(req)
    const body = raw ? (raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : null
    requests.push({ method: req.method ?? 'GET', path: url.pathname, body })
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    // OAuth device flow (no auth header)
    if (url.pathname === '/login/device/code') return json(200, { device_code: 'dev-123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 })
    if (url.pathname === '/login/oauth/access_token') {
      polls++
      return json(200, polls < 2 ? { error: 'authorization_pending' } : { access_token: TOKEN, token_type: 'bearer', scope: 'repo,read:user' })
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' })
    const p = url.pathname
    if (p === '/user') return json(200, { login: 'octo', name: 'Octo' })
    if (p === '/repos/acme/widgets') return json(200, { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false, permissions: { push: true } })
    if (p === '/repos/acme/widgets/pulls' && req.method === 'GET') return json(200, [prJson])
    if (p === '/repos/acme/widgets/pulls/12') return json(200, prJson)
    if (p === '/repos/acme/widgets/pulls/12/reviews' && req.method === 'GET') return json(200, [{ id: 1, user: { login: 'maya' }, state: 'APPROVED', body: '', submitted_at: '2026-10-02T09:00:00Z' }])
    if (p === '/repos/acme/widgets/pulls/12/reviews' && req.method === 'POST') return json(200, { id: 2 })
    if (p === '/repos/acme/widgets/issues/12/comments' && req.method === 'GET') return json(200, [{ id: 7, user: { login: 'maya' }, body: 'Looks great!', created_at: '2026-10-02T09:00:00Z' }])
    if (p === '/repos/acme/widgets/issues/12/comments' && req.method === 'POST') return json(201, { id: 8, user: { login: 'octo' }, body: (body as { body: string }).body, created_at: '2026-10-03T09:00:00Z' })
    if (p === '/repos/acme/widgets/pulls/12/comments') return json(200, [])
    if (p === '/repos/acme/widgets/pulls/12/merge') return json(200, { merged: true, sha: 'b'.repeat(40), message: 'Pull Request successfully merged' })
    if (p.includes('/commits/')) return json(200, p.endsWith('/status') ? { state: 'success', statuses: [{ state: 'success', context: 'ci', target_url: 'https://ci.example/1' }] } : { total_count: 0, check_runs: [] })
    json(404, { message: 'Not Found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, requests, close: () => new Promise((r) => server.close(r)) }
}

async function launch(repo: string, api: string, userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, repo],
    env: {
      ...process.env,
      GITBOB_USER_DATA: userData,
      ELECTRON_RENDERER_URL: '',
      GITBOB_EPHEMERAL_TOKENS: '1',
      GITBOB_TEST_PROVIDER_API_GITHUB: api,
      GITBOB_TEST_GITHUB_OAUTH: api,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(makeTempDir('gitbob-home-'), '.gitconfig'),
    },
  })
  await app.evaluate(({ shell }) => {
    shell.openExternal = (async () => {}) as typeof shell.openExternal
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test.afterAll(cleanupFixtures)

test('sign in with GitHub, review a pull request, see its files and merge it', async () => {
  // A local bare "server" holds the branches and GitHub's refs/pull/12/head.
  const seed = createFixtureRepo()
  const base = seed.commit('base', { 'a.txt': 'one\ntwo\n' })
  seed.git(['switch', '-q', '-c', 'feature/login'])
  const head = seed.commit('Add login form', { 'a.txt': 'one\nTWO\n', 'login.ts': 'export const login = 1\n' })
  const server = createFixtureRepo({ bare: true })
  seed.git(['push', '-q', server.dir, 'main', 'feature/login', 'feature/login:refs/pull/12/head'])
  const work = createFixtureRepo()
  work.git(['remote', 'add', 'origin', server.dir])
  // Push URL tells GitBob which GitHub repository this is; fetches go to the local server.
  work.git(['remote', 'set-url', '--push', 'origin', 'https://github.com/acme/widgets.git'])
  work.git(['fetch', '-q', 'origin'])
  work.git(['switch', '-q', 'main'])

  const api = await fakeGitHub({ head, base })
  const userData = makeTempDir('gitbob-ud-')
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ githubClientId: 'Ov23liTESTCLIENT' }))
  const { app, page } = await launch(work.dir, api.url, userData)
  try {
    const section = page.getByTestId('pull-requests')
    await section.getByTestId('signin-github').click()
    await expect(page.getByTestId('notice')).toContainText('Signed in to GitHub as octo', { timeout: 15_000 })
    await section.getByTestId('pull-request').click()

    const view = page.getByTestId('pr-view')
    await expect(view.getByTestId('pr-title')).toHaveText('Add login form')
    await expect(view.getByTestId('pr-state')).toHaveText('Open')
    await expect(view.getByTestId('pr-body')).toContainText('Closes #3.')
    await expect(view.getByTestId('pr-reviewers')).toContainText('maya (approved)')
    await expect(view.getByTestId('pr-comments')).toContainText('Looks great!')

    // Files come from the locally fetched pull request commits.
    await view.getByRole('tab', { name: 'Files' }).click()
    await expect(view.getByTestId('pr-file')).toHaveCount(2)
    await view.getByTestId('pr-file').filter({ hasText: 'a.txt' }).click()
    await expect(page.getByTestId('diff-table')).toContainText('TWO')
    await page.getByTestId('diff-view').getByRole('button', { name: 'Close' }).click()
    await expect(page.getByTestId('pr-view')).toBeVisible()
    expect(work.git(['rev-parse', 'refs/gitbob/pr/12'])).toBe(head)

    // Comment and approve.
    await view.getByRole('tab', { name: 'Conversation' }).click()
    await view.getByLabel('Comment or review').fill('Ship it')
    await view.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(page.getByTestId('notice')).toContainText('Comment posted')
    await view.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByTestId('notice')).toContainText('Approved')

    // Merge (confirmed natively), guarded by the reviewed head sha.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (() => Promise.resolve({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    })
    await view.getByLabel('Merge method').selectOption('squash')
    await view.getByRole('button', { name: 'Merge pull request' }).click()
    await expect(page.getByTestId('notice')).toContainText('Pull request #12 merged')

    const merge = api.requests.find((r) => r.path.endsWith('/pulls/12/merge'))
    expect(merge?.body).toMatchObject({ merge_method: 'squash', sha: head })
    expect(api.requests.find((r) => r.method === 'POST' && r.path.endsWith('/reviews'))?.body).toMatchObject({ event: 'APPROVE' })
  } finally {
    await app.close()
    await api.close()
  }
})

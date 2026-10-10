import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')
const TOKEN = 'github_pat_test_123'

/** Minimal fake of the GitHub REST endpoints GitBob uses. */
async function fakeGitHub(headSha: string) {
  const created: Record<string, unknown>[] = []
  const body = (req: IncomingMessage) =>
    new Promise<string>((r) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => r(b))
    })
  const pulls = [
    {
      id: 1001, number: 12, title: 'Add dark mode', state: 'open', draft: false, merged_at: null,
      user: { login: 'kenji' }, head: { ref: 'feature/dark-mode' }, base: { ref: 'main' },
      html_url: 'https://github.com/acme/widgets/pull/12', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-02T10:00:00Z',
    },
  ]
  const server: Server = createServer(async (req, res) => {
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/user') return json(200, { login: 'octo-tester', name: 'Octo' })
    if (url.pathname === '/repos/acme/widgets/pulls' && req.method === 'GET') return json(200, pulls)
    if (url.pathname === '/repos/acme/widgets/pulls' && req.method === 'POST') {
      const input = JSON.parse(await body(req)) as Record<string, unknown>
      created.push(input)
      return json(201, {
        ...pulls[0], id: 1002, number: 13, title: input.title, draft: input.draft,
        head: { ref: input.head }, base: { ref: input.base }, html_url: 'https://github.com/acme/widgets/pull/13',
      })
    }
    if (url.pathname === `/repos/acme/widgets/commits/${headSha}/status`)
      return json(200, { state: 'success', statuses: [{ state: 'success', context: 'ci/lint', target_url: 'https://ci.example/1' }] })
    if (url.pathname === `/repos/acme/widgets/commits/${headSha}/check-runs`)
      return json(200, { total_count: 2, check_runs: [
        { status: 'completed', conclusion: 'success', name: 'build', html_url: 'https://ci.example/2' },
        { status: 'completed', conclusion: 'failure', name: 'test', html_url: 'https://ci.example/3' },
      ] })
    if (url.pathname.includes('/commits/')) return json(200, url.pathname.endsWith('/status') ? { state: 'pending', statuses: [] } : { total_count: 0, check_runs: [] })
    json(404, { message: 'Not Found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, created, close: () => new Promise((r) => server.close(r)) }
}

async function launch(repo: string, api: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, repo],
    env: {
      ...process.env,
      GITBOB_USER_DATA: makeTempDir('gitbob-ud-'),
      ELECTRON_RENDERER_URL: '',
      GITBOB_EPHEMERAL_TOKENS: '1',
      GITBOB_TEST_PROVIDER_API_GITHUB: api,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(makeTempDir('gitbob-home-'), '.gitconfig'),
    },
  })
  // Never open the real browser from tests.
  await app.evaluate(({ shell }) => {
    ;(globalThis as Record<string, unknown>).__opened = []
    shell.openExternal = (async (u: string) => {
      ;((globalThis as Record<string, unknown>).__opened as string[]).push(u)
    }) as typeof shell.openExternal
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test.afterAll(cleanupFixtures)

test('connects GitHub with a token, lists pull requests, shows CI and creates a pull request', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1' })
  repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  repo.git(['switch', '-q', '-c', 'feature/login'])
  const head = repo.commit('Add login form', { 'login.ts': 'x' })
  repo.git(['update-ref', 'refs/remotes/origin/feature/login', 'HEAD'])
  repo.git(['branch', '-q', '--set-upstream-to=origin/feature/login'])
  const api = await fakeGitHub(head)
  const { app, page } = await launch(repo.dir, api.url)
  try {
    const section = page.getByTestId('pull-requests')
    await expect(section).toContainText('GitHub · acme/widgets')

    // Wrong token is rejected and not stored.
    await section.getByTestId('connect-provider').click()
    await page.getByLabel(/Personal access token/).fill('nope')
    await page.getByTestId('prompt-dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByTestId('error-message')).toBeVisible()
    await page.getByRole('button', { name: 'Dismiss error' }).click()
    expect(await app.evaluate(() => (globalThis as Record<string, unknown>).__opened)).toEqual([
      'https://github.com/settings/personal-access-tokens/new',
    ])

    await section.getByTestId('connect-provider').click()
    await page.getByLabel(/Personal access token/).fill(TOKEN)
    await page.getByTestId('prompt-dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByTestId('notice')).toContainText('Connected to GitHub as octo-tester')
    await expect(section.getByTestId('pull-request')).toHaveCount(1)
    await expect(section.getByTestId('pull-request')).toContainText('#12')
    await expect(section.getByTestId('pull-request')).toContainText('Add dark mode')

    // CI status of the selected commit.
    await page.locator(`[data-sha="${head}"]`).click()
    await expect(page.getByTestId('ci-status')).toHaveText('✗ 1 of 3 failed')

    // Create a pull request from the branch menu.
    await page.locator('[data-testid="ref-item"][data-ref="refs/heads/feature/login"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Create pull request…' }).click()
    const dialog = page.getByTestId('create-pr-dialog')
    await expect(dialog.getByLabel('Pull request title')).toHaveValue('Add login form')
    await dialog.getByLabel('Pull request description').fill('Adds the login form.')
    await dialog.getByText('Create as draft').click()
    await dialog.getByRole('button', { name: 'Create pull request' }).click()
    await expect(page.getByTestId('notice')).toContainText('Pull request #13 created')
    expect(api.created).toEqual([
      { title: 'Add login form', body: 'Adds the login form.', head: 'feature/login', base: 'main', draft: true },
    ])
  } finally {
    await app.close()
    await api.close()
  }
})

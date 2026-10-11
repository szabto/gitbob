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
    if (url.pathname === '/repos/acme/widgets/issues')
      return json(200, [{ number: 31, title: 'Dark mode flickers', user: { login: 'ann' }, html_url: 'https://github.com/acme/widgets/issues/31', labels: [{ name: 'bug' }], comments: 0, updated_at: '2026-10-02T00:00:00Z' }])
    if (url.pathname === '/user/repos')
      return json(200, [
        { full_name: 'acme/widgets', description: 'Widget factory', private: true, clone_url: 'https://github.com/acme/widgets.git', ssh_url: 'git@github.com:acme/widgets.git', pushed_at: '2026-10-02T00:00:00Z' },
        { full_name: 'octo-tester/dotfiles', description: null, private: false, clone_url: 'https://github.com/octo-tester/dotfiles.git', ssh_url: 'git@github.com:octo-tester/dotfiles.git', pushed_at: '2026-09-01T00:00:00Z' },
      ])
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

    // Issues (collapsed by default) list the repository's open issues.
    const issues = page.getByTestId('issues')
    await issues.locator('> div > button').click()
    await expect(issues.getByTestId('issue')).toHaveCount(1)
    await expect(issues.getByTestId('issue')).toContainText('#31 Dark mode flickers')

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

test('the clone dialog lists the repositories of connected accounts', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1' })
  repo.git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  const api = await fakeGitHub('0'.repeat(40))
  const { app, page } = await launch(repo.dir, api.url)
  const openClone = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:clone-repository'))
  try {
    // Not connected yet: a plain URL field with a hint.
    await openClone()
    const dialog = page.getByTestId('clone-dialog')
    await expect(dialog).toContainText('to pick from your repositories here')
    await expect(dialog.getByTestId('clone-repo-list')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    const section = page.getByTestId('pull-requests')
    await section.getByTestId('connect-provider').click()
    await page.getByLabel(/Personal access token/).fill(TOKEN)
    await page.getByTestId('prompt-dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByTestId('notice')).toContainText('Connected to GitHub')

    await openClone()
    await expect(dialog).toContainText('From GitHub')
    const list = dialog.getByTestId('clone-repo-list')
    await expect(list.getByTestId('clone-repo')).toHaveCount(2)
    await expect(list.getByTestId('clone-repo').first()).toContainText('acme/widgets')
    await expect(list.getByTestId('clone-repo').first()).toContainText('Private')

    // Typing filters; Enter picks the highlighted repository.
    const input = dialog.getByLabel('Repository URL')
    await input.fill('dot')
    await expect(list.getByTestId('clone-repo')).toHaveCount(1)
    await input.press('Enter')
    await expect(input).toHaveValue('https://github.com/octo-tester/dotfiles.git')
    await dialog.getByText('Use SSH').click()
    await expect(input).toHaveValue('git@github.com:octo-tester/dotfiles.git')

    // Clicking a repository works too.
    await input.click()
    await list.locator('[data-name="acme/widgets"]').click()
    await expect(input).toHaveValue('git@github.com:acme/widgets.git')
    await expect(dialog.getByRole('button', { name: 'Choose folder…' })).toBeEnabled()
  } finally {
    await app.close()
    await api.close()
  }
})

test('explains when GitHub hides an organization repository from the sign-in', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1' })
  // The fake API knows acme/widgets only; this repository answers 404 like an unapproved org repo.
  repo.git(['remote', 'add', 'origin', 'https://github.com/acme-private/secret.git'])
  const api = await fakeGitHub('0'.repeat(40))
  const { app, page } = await launch(repo.dir, api.url)
  try {
    const section = page.getByTestId('pull-requests')
    await section.getByTestId('connect-provider').click()
    await page.getByLabel(/Personal access token/).fill(TOKEN)
    await page.getByTestId('prompt-dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    const error = section.getByTestId('pulls-error')
    await expect(error).toContainText("GitHub doesn't let this sign-in see acme-private/secret")
    await expect(error.getByRole('button', { name: 'Use an access token…' })).toBeVisible()
  } finally {
    await app.close()
    await api.close()
  }
})

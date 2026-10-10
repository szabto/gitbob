import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join, resolve } from 'node:path'
import { cleanupFixtures, cloneFixtureRepo, createFixtureRepo, makeTempDir, type FixtureRepo } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')

async function launch(repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, repo],
    env: {
      ...process.env,
      GITBOB_USER_DATA: makeTempDir('gitbob-ud-'),
      ELECTRON_RENDERER_URL: '',
      GIT_AUTHOR_NAME: 'E2E Author',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E Author',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(makeTempDir('gitbob-home-'), '.gitconfig'),
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

function setup(): { server: FixtureRepo; alice: FixtureRepo; bob: FixtureRepo } {
  const seed = createFixtureRepo()
  seed.commit('seed', { 'f.txt': '1\n' })
  const server = createFixtureRepo({ bare: true })
  seed.git(['push', '-q', server.dir, 'main'])
  return { server, alice: cloneFixtureRepo(server), bob: cloneFixtureRepo(server) }
}

const mockConfirm = (app: ElectronApplication, response: number) =>
  app.evaluate(({ dialog }, r) => {
    dialog.showMessageBox = (() => Promise.resolve({ response: r, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, response)

const sidebarRef = (page: Page, ref: string) => page.locator(`[data-testid="ref-item"][data-ref="${ref}"]`)

test.afterAll(cleanupFixtures)

test('fetch and pull bring in commits pushed by someone else', async () => {
  const { alice, bob } = setup()
  const { app, page } = await launch(alice.dir)
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(1)
    await expect(page.getByTestId('tracking-status')).toHaveText('↑0 ↓0')

    const sha = bob.commit('bob was here', { 'b.txt': 'b\n' })
    bob.git(['push', '-q'])

    await page.getByRole('button', { name: 'Fetch' }).click()
    await expect(page.locator(`[data-sha="${sha}"] [data-ref="refs/remotes/origin/main"]`)).toBeVisible()
    await expect(page.getByTestId('tracking-status')).toHaveText('↑0 ↓1')

    await page.getByRole('button', { name: 'Pull', exact: true }).click()
    await expect(page.locator(`[data-sha="${sha}"] [data-ref="refs/heads/main"]`)).toBeVisible()
    await expect(page.getByTestId('tracking-status')).toHaveText('↑0 ↓0')
    expect(alice.head()).toBe(sha)
  } finally {
    await app.close()
  }
})

test('creates, pushes, renames, checks out and deletes branches', async () => {
  const { server, alice } = setup()
  const { app, page } = await launch(alice.dir)
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(1)

    // Create + checkout via the toolbar.
    await page.getByRole('button', { name: 'Branch', exact: true }).click()
    await page.getByLabel('Branch name').fill('feature/login')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('head-label')).toHaveText('feature/login')
    expect(alice.git(['symbolic-ref', '--short', 'HEAD'])).toBe('feature/login')

    // Invalid names are rejected with git's rules.
    await page.getByRole('button', { name: 'Branch', exact: true }).click()
    await page.getByLabel('Branch name').fill('bad..name')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('error-message')).toContainText('not a valid branch name')
    await page.getByRole('button', { name: 'Dismiss error' }).click()

    // Push the new branch: sets upstream on the only remote.
    alice.commit('login form', { 'login.ts': 'x\n' })
    await expect(page.getByTestId('commit-row')).toHaveCount(2, { timeout: 10_000 })
    await page.getByRole('button', { name: 'Push' }).click()
    await expect(page.getByTestId('tracking-status')).toHaveText('↑0 ↓0')
    expect(server.git(['rev-parse', 'feature/login'])).toBe(alice.head())
    expect(alice.git(['rev-parse', '--abbrev-ref', 'feature/login@{upstream}'])).toBe('origin/feature/login')

    // Double-click checks out main.
    await sidebarRef(page, 'refs/heads/main').dblclick()
    await expect(page.getByTestId('head-label')).toHaveText('main')

    // Rename via context menu.
    await sidebarRef(page, 'refs/heads/feature/login').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    await page.getByLabel('New name').fill('feature/signin')
    await page.getByRole('button', { name: 'Rename' }).click()
    await expect(sidebarRef(page, 'refs/heads/feature/signin')).toBeVisible()

    // Delete: unmerged, so main asks twice (normal, then force). Declining keeps the branch.
    await mockConfirm(app, 0)
    await sidebarRef(page, 'refs/heads/feature/signin').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Delete feature\/signin/ }).click()
    await page.waitForTimeout(300)
    expect(alice.git(['branch', '--list', 'feature/signin'])).toContain('feature/signin')

    await mockConfirm(app, 1)
    await sidebarRef(page, 'refs/heads/feature/signin').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Delete feature\/signin/ }).click()
    await expect(sidebarRef(page, 'refs/heads/feature/signin')).toHaveCount(0)
    expect(alice.git(['branch', '--list', 'feature/signin'])).toBe('')
  } finally {
    await app.close()
  }
})

test('checks out a remote branch as a tracking branch and a commit detached', async () => {
  const { alice, bob } = setup()
  bob.git(['switch', '-q', '-c', 'topic'])
  bob.commit('topic work', { 't.txt': 't\n' })
  bob.git(['push', '-q', '-u', 'origin', 'topic'])
  alice.git(['fetch', '-q'])
  const { app, page } = await launch(alice.dir)
  try {
    await sidebarRef(page, 'refs/remotes/origin/topic').dblclick()
    await expect(page.getByTestId('head-label')).toHaveText('topic')
    expect(alice.git(['rev-parse', '--abbrev-ref', 'topic@{upstream}'])).toBe('origin/topic')

    const seed = alice.rev('main')
    await page.locator(`[data-sha="${seed}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Checkout this commit (detached)' }).click()
    await expect(page.getByTestId('head-label')).toHaveText(`HEAD detached at ${seed.slice(0, 7)}`)
  } finally {
    await app.close()
  }
})

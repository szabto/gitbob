import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')

async function launch(repo?: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, ...(repo ? [repo] : [])],
    env: {
      ...process.env,
      GITBOB_USER_DATA: makeTempDir('gitbob-ud-'),
      ELECTRON_RENDERER_URL: '',
      GITBOB_HIDDEN: '1',
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

const pickFolder = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, path)

test.afterAll(cleanupFixtures)

test('clones a repository into a chosen folder and opens it', async () => {
  const seed = createFixtureRepo()
  seed.commit('first', { 'a.txt': '1' })
  seed.commit('second', { 'a.txt': '2' })
  const server = createFixtureRepo({ bare: true })
  seed.git(['push', '-q', server.dir, 'main'])
  const parent = makeTempDir('gitbob-clone-target-')
  const { app, page } = await launch()
  try {
    await pickFolder(app, parent)
    await page.getByRole('button', { name: 'Clone…' }).click()
    await page.getByLabel('Repository URL').fill(server.dir)
    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('commit-row')).toHaveCount(2)
    await expect(page.getByTestId('repo-tab')).toHaveCount(1)
    const name = server.dir.split('/').pop()!.replace(/\.git$/, '')
    expect(existsSync(join(parent, name, 'a.txt'))).toBe(true)
    await expect(page.locator('[data-testid="ref-item"][data-ref="refs/remotes/origin/main"]')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('rejects dangerous clone URLs without running anything', async () => {
  const parent = makeTempDir('gitbob-clone-target-')
  const marker = join(parent, 'PWNED')
  const { app, page } = await launch()
  try {
    await pickFolder(app, parent)
    await page.getByRole('button', { name: 'Clone…' }).click()
    await page.getByLabel('Repository URL').fill(`ext::sh -c touch% ${marker}`)
    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('error-message')).toBeVisible()
    expect(existsSync(marker)).toBe(false)
  } finally {
    await app.close()
  }
})

test('creates a new repository', async () => {
  const dir = join(makeTempDir('gitbob-init-'), 'fresh-project')
  const { app, page } = await launch()
  try {
    await pickFolder(app, dir)
    await page.getByRole('button', { name: 'New repository…' }).click()
    await expect(page.getByTestId('empty-history')).toBeVisible()
    await expect(page.getByTestId('head-label')).toHaveText('main (no commits)')
    expect(existsSync(join(dir, '.git'))).toBe(true)
  } finally {
    await app.close()
  }
})

test('filters the graph by branch, author and path', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'README.md': 'r' })
  repo.branch('feature')
  repo.commit('main docs', { 'docs/guide.md': 'g' })
  repo.checkout('feature')
  repo.commit('feature code', { 'src/app.ts': 'a' })
  repo.git(['commit', '--allow-empty', '-q', '-m', 'feature by zoe'], { GIT_AUTHOR_NAME: 'Zoë Example', GIT_AUTHOR_EMAIL: 'zoe@example.org' })
  repo.checkout('main')
  const { app, page } = await launch(repo.dir)
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(4)
    const subjects = () => page.getByTestId('commit-subject').allTextContents()

    // Branch filter.
    await page.getByTestId('filter-button').click()
    await page.getByTestId('filter-form').getByLabel('feature').check()
    await page.getByRole('button', { name: 'Apply filter' }).click()
    await expect(page.getByTestId('commit-row')).toHaveCount(3)
    expect(await subjects()).toEqual(['feature by zoe', 'feature code', 'base'])
    await expect(page.getByTestId('filter-summary')).toContainText('feature')

    // Author filter (literal, case-insensitive), replacing the branch filter.
    await page.getByTestId('filter-button').click()
    await page.getByTestId('filter-form').getByLabel('feature').uncheck()
    await page.getByLabel('Author').fill('ZOE@')
    await page.getByRole('button', { name: 'Apply filter' }).click()
    await expect(page.getByTestId('commit-row')).toHaveCount(1)
    expect(await subjects()).toEqual(['feature by zoe'])

    // Path filter.
    await page.getByTestId('filter-button').click()
    await page.getByLabel('Author').fill('')
    await page.getByLabel('File or folder').fill('docs')
    await page.getByRole('button', { name: 'Apply filter' }).click()
    await expect(page.getByTestId('commit-row')).toHaveCount(1)
    expect(await subjects()).toEqual(['main docs'])

    // No matches, then clear.
    await page.getByTestId('filter-button').click()
    await page.getByLabel('File or folder').fill('nope/never')
    await page.getByRole('button', { name: 'Apply filter' }).click()
    await expect(page.getByTestId('filtered-empty')).toBeVisible()
    await page.getByRole('button', { name: 'Clear filter' }).first().click()
    await expect(page.getByTestId('commit-row')).toHaveCount(4)
  } finally {
    await app.close()
  }
})

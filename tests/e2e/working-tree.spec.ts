import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir, type FixtureRepo } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')

async function launch(repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, repo],
    env: {
      ...process.env,
      GITBOB_USER_DATA: makeTempDir('gitbob-ud-'),
      ELECTRON_RENDERER_URL: '',
      // Commits made through the app need an identity; keep the fixture isolated from the user's config.
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

function baseRepo(): FixtureRepo {
  const repo = createFixtureRepo()
  repo.commit('Initial commit', { 'README.md': 'hello\n', 'src/app.ts': 'export const a = 1\n' })
  repo.commit('Second commit', { 'src/app.ts': 'export const a = 2\n' })
  return repo
}

const fileRow = (page: Page, section: string, path: string) =>
  page.getByTestId(section).locator(`[data-testid="status-file"][data-path="${path}"]`)

test.afterAll(cleanupFixtures)

test('stages changes, shows diffs, and commits them through the UI', async () => {
  const repo = baseRepo()
  repo.write('src/app.ts', 'export const a = 3\nexport const b = 4\n')
  repo.write('notes/new file.txt', 'brand new\n')
  const { app, page } = await launch(repo.dir)
  try {
    await expect(page.getByTestId('wip-row')).toBeVisible()
    await expect(page.getByTestId('wip-row')).toContainText('2 unstaged')
    await page.getByTestId('wip-row').click()

    await expect(fileRow(page, 'unstaged-files', 'src/app.ts')).toBeVisible()
    await expect(fileRow(page, 'unstaged-files', 'notes/new file.txt')).toBeVisible()

    // Diff of a modified file.
    await fileRow(page, 'unstaged-files', 'src/app.ts').click()
    await expect(page.getByTestId('diff-path')).toHaveText('src/app.ts')
    await expect(page.locator('[data-line-type="add"]')).toHaveCount(2)
    await expect(page.locator('[data-line-type="del"]')).toHaveCount(1)
    await expect(page.getByTestId('diff-table')).toContainText('export const b = 4')

    // Diff of an untracked file.
    await fileRow(page, 'unstaged-files', 'notes/new file.txt').click()
    await expect(page.getByTestId('diff-table')).toContainText('brand new')

    // Stage one file via its row action.
    await fileRow(page, 'unstaged-files', 'src/app.ts').hover()
    await fileRow(page, 'unstaged-files', 'src/app.ts').getByRole('button', { name: 'Stage' }).click()
    await expect(fileRow(page, 'staged-files', 'src/app.ts')).toBeVisible()
    await expect(fileRow(page, 'unstaged-files', 'src/app.ts')).toHaveCount(0)
    expect(repo.git(['diff', '--cached', '--name-only'])).toBe('src/app.ts')

    // Unstage and restage with the bulk buttons.
    await page.getByRole('button', { name: 'Unstage all' }).click()
    await expect(fileRow(page, 'unstaged-files', 'src/app.ts')).toBeVisible()
    await page.getByRole('button', { name: 'Stage all' }).click()
    await expect(fileRow(page, 'staged-files', 'notes/new file.txt')).toBeVisible()
    await expect(fileRow(page, 'staged-files', 'src/app.ts')).toBeVisible()

    // Commit.
    await page.getByLabel('Commit summary').fill('Add b and notes')
    await page.getByLabel('Commit description').fill('Body line with $(not a command) and "quotes"')
    await page.getByRole('button', { name: 'Commit 2 files' }).click()
    await expect(page.getByTestId('details-subject')).toHaveText('Add b and notes')

    expect(repo.git(['log', '-1', '--format=%B'])).toBe('Add b and notes\n\nBody line with $(not a command) and "quotes"')
    expect(repo.git(['status', '--porcelain'])).toBe('')

    // The graph shows the new commit at the top and the WIP row disappears.
    await expect(page.getByTestId('commit-row').first().getByTestId('commit-subject')).toHaveText('Add b and notes')
    await expect(page.getByTestId('wip-row')).toHaveCount(0)
    await expect(page.getByTestId('commit-count')).toHaveText('3 commits')
  } finally {
    await app.close()
  }
})

test('detects changes made outside the app', async () => {
  const repo = baseRepo()
  const { app, page } = await launch(repo.dir)
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(2)
    await expect(page.getByTestId('wip-row')).toHaveCount(0)

    writeFileSync(join(repo.dir, 'README.md'), 'changed outside\n')
    await expect(page.getByTestId('wip-row')).toBeVisible({ timeout: 10_000 })

    // A commit made with the git CLI shows up in the graph.
    repo.git(['commit', '-qam', 'External commit'])
    await expect(page.getByTestId('commit-row').first().getByTestId('commit-subject')).toHaveText('External commit', {
      timeout: 10_000,
    })
    await expect(page.getByTestId('wip-row')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('discard requires native confirmation and keeps staged content', async () => {
  const repo = baseRepo()
  repo.write('src/app.ts', 'staged version\n')
  repo.git(['add', 'src/app.ts'])
  repo.write('src/app.ts', 'unstaged version\n')
  const { app, page } = await launch(repo.dir)
  const setDialogResponse = (response: number) =>
    app.evaluate(({ dialog }, r) => {
      dialog.showMessageBox = (() => Promise.resolve({ response: r, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, response)
  try {
    await page.getByTestId('wip-row').click()
    const row = fileRow(page, 'unstaged-files', 'src/app.ts')
    await expect(row).toBeVisible()

    // Cancel: nothing changes.
    await setDialogResponse(0)
    await row.hover()
    await row.getByRole('button', { name: 'Discard' }).click()
    await page.waitForTimeout(300)
    expect(readFileSync(join(repo.dir, 'src/app.ts'), 'utf8')).toBe('unstaged version\n')

    // Confirm: worktree is restored from the index; the staged change is untouched.
    await setDialogResponse(1)
    await row.hover()
    await row.getByRole('button', { name: 'Discard' }).click()
    await expect(fileRow(page, 'unstaged-files', 'src/app.ts')).toHaveCount(0)
    expect(readFileSync(join(repo.dir, 'src/app.ts'), 'utf8')).toBe('staged version\n')
    expect(repo.git(['diff', '--cached', '--name-only'])).toBe('src/app.ts')
  } finally {
    await app.close()
  }
})

test('amend prefills the previous message and rewrites HEAD', async () => {
  const repo = baseRepo()
  const before = repo.head()
  const parent = repo.rev('HEAD~1')
  const { app, page } = await launch(repo.dir)
  try {
    repo.write('extra.txt', 'x\n')
    await expect(page.getByTestId('wip-row')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('wip-row').click()
    await page.getByRole('button', { name: 'Stage all' }).click()
    await expect(fileRow(page, 'staged-files', 'extra.txt')).toBeVisible()

    await page.getByTestId('amend-checkbox').check()
    await expect(page.getByLabel('Commit summary')).toHaveValue('Second commit')
    await page.getByLabel('Commit summary').fill('Second commit (amended)')
    await page.getByRole('button', { name: 'Amend commit' }).click()
    await expect(page.getByTestId('details-subject')).toHaveText('Second commit (amended)')

    expect(repo.head()).not.toBe(before)
    expect(repo.rev('HEAD~1')).toBe(parent)
    expect(repo.git(['log', '-1', '--format=%s'])).toBe('Second commit (amended)')
    expect(repo.git(['show', '--name-only', '--format=', 'HEAD']).split('\n')).toContain('extra.txt')
  } finally {
    await app.close()
  }
})

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')

async function launch(repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, repo],
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

const row = (page: Page, subject: string) => page.locator('[data-testid="commit-row"]', { hasText: subject })

test.afterAll(cleanupFixtures)

test('interactive rebase: reword, squash and drop', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '0\n' })
  repo.commit('add one', { 'one.txt': '1\n' })
  repo.commit('fix typo in one', { 'one.txt': 'one\n' })
  repo.commit('temporary debug', { 'debug.txt': 'x\n' })
  repo.commit('add two', { 'two.txt': '2\n' })
  const { app, page } = await launch(repo.dir)
  try {
    await row(page, 'base').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Interactive rebase main onto here/ }).click()
    const dialog = page.getByTestId('rebase-dialog')
    await expect(dialog.getByTestId('rebase-row')).toHaveCount(4)

    await dialog.getByLabel('Action for add one').selectOption('reword')
    await dialog.getByLabel('New message for add one').fill('Add file one ($HOME stays literal)')
    await dialog.getByLabel('Action for fix typo in one').selectOption('fixup')
    await dialog.getByLabel('Action for temporary debug').selectOption('drop')
    await dialog.getByRole('button', { name: 'Start rebase' }).click()

    await expect(page.getByTestId('rebase-dialog')).toHaveCount(0)
    await expect(page.getByTestId('commit-row')).toHaveCount(3)
    expect(repo.git(['log', '--format=%s'])).toBe('add two\nAdd file one ($HOME stays literal)\nbase')
    expect(repo.git(['show', 'HEAD~1:one.txt'])).toBe('one')
    expect(existsSync(join(repo.dir, 'debug.txt'))).toBe(false)
  } finally {
    await app.close()
  }
})

test('blame shows who changed each line and links to the commit', async () => {
  const repo = createFixtureRepo()
  repo.commit('first version', { 'f.txt': 'alpha\nbeta\n' })
  repo.git(['commit', '--allow-empty', '-q', '-m', 'noop'])
  repo.write('f.txt', 'alpha\nBETA\n')
  repo.git(['commit', '-qam', 'shout beta'], { GIT_AUTHOR_NAME: 'Second Person', GIT_AUTHOR_EMAIL: 's@example.com' })
  const { app, page } = await launch(repo.dir)
  try {
    await row(page, 'shout beta').click()
    await page.locator('[data-testid="details-file"][data-path="f.txt"]').click()
    await page.getByRole('button', { name: 'Blame' }).click()
    const lines = page.getByTestId('blame-line')
    await expect(lines).toHaveCount(2)
    await expect(lines.nth(0)).toContainText('Test Author')
    await expect(lines.nth(1)).toContainText('Second Person')
    await lines.nth(0).getByRole('button').click()
    await expect(page.getByTestId('details-subject')).toHaveText('first version')
  } finally {
    await app.close()
  }
})

test('adds a worktree in a chosen folder and lists it', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1\n' })
  const target = join(makeTempDir('gitbob-wt-'), 'side')
  const { app, page } = await launch(repo.dir)
  try {
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
    }, target)
    await page.getByTestId('worktrees').getByRole('button', { name: 'Add worktree' }).click()
    await page.getByLabel(/New branch for the worktree/).fill('side-task')
    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('notice')).toContainText('Worktree created')
    await expect(page.getByTestId('worktree-item')).toHaveCount(2)
    await expect(page.getByTestId('worktrees')).toContainText('side-task')
    expect(existsSync(join(target, 'a.txt'))).toBe(true)
  } finally {
    await app.close()
  }
})

test('file history follows renames and shows each commit’s change', async () => {
  const repo = createFixtureRepo()
  const body = 'line one\nline two\nline three\nline four\nline five\n'
  repo.commit('add settings', { 'old-name.txt': body, 'other.txt': 'x' })
  repo.commit('unrelated change', { 'other.txt': 'y' })
  repo.git(['mv', 'old-name.txt', 'settings.txt'])
  repo.commit('rename settings')
  repo.commit('tune settings', { 'settings.txt': body.replace('line two', 'line TWO') })
  const { app, page } = await launch(repo.dir)
  try {
    await row(page, 'tune settings').click()
    await page.locator('[data-testid="details-file"][data-path="settings.txt"]').click()
    await page.getByTestId('diff-view').getByRole('button', { name: 'History' }).click()

    const view = page.getByTestId('file-history')
    const entries = view.getByTestId('file-history-entry')
    await expect(entries).toHaveCount(3)
    await expect(entries.nth(0)).toContainText('tune settings')
    await expect(entries.nth(1)).toContainText('Renamed from old-name.txt')
    await expect(entries.nth(2)).toContainText('Added')
    await expect(view.getByTestId('file-history-count')).toHaveText('3 commits')
    await expect(view.getByTestId('diff-table')).toContainText('line TWO')

    // The oldest entry shows the file as added under its old name.
    await entries.nth(2).click()
    await expect(view.getByTestId('diff-path')).toHaveText('old-name.txt')
    await expect(view.locator('[data-line-type="add"]')).toHaveCount(5)

    // Double-click jumps to the commit in the graph.
    await entries.nth(1).dblclick()
    await expect(page.getByTestId('file-history')).toHaveCount(0)
    await expect(page.getByTestId('details-subject')).toHaveText('rename settings')

    // Also reachable from a file's context menu in the commit details.
    await page.locator('[data-testid="details-file"][data-path="settings.txt"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'File history' }).click()
    await expect(page.getByTestId('file-history-entry')).toHaveCount(3)
  } finally {
    await app.close()
  }
})

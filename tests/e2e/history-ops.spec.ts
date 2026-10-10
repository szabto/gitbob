import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
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

const mockConfirm = (app: ElectronApplication, response: number) =>
  app.evaluate(({ dialog }, r) => {
    dialog.showMessageBox = (() => Promise.resolve({ response: r, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, response)

const row = (page: Page, subject: string) => page.locator('[data-testid="commit-row"]', { hasText: subject })
const read = (repo: FixtureRepo, p: string) => readFileSync(join(repo.dir, p), 'utf8')

test.afterAll(cleanupFixtures)

test('stashes changes, shows the stash, and pops it back', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': 'one\n' })
  repo.write('a.txt', 'edited\n')
  repo.write('new.txt', 'brand new\n')
  const { app, page } = await launch(repo.dir)
  try {
    await page.getByTestId('wip-row').click()
    await page.getByRole('button', { name: 'Stash…' }).click()
    await page.getByLabel('Message (optional)').fill('half-done edit')
    await page.getByRole('button', { name: 'Stash', exact: true }).click()

    await expect(page.getByTestId('stash-item')).toHaveText('half-done edit')
    await expect(page.getByTestId('wip-row')).toHaveCount(0)
    expect(read(repo, 'a.txt')).toBe('one\n')
    expect(repo.git(['status', '--porcelain'])).toBe('')

    await page.getByTestId('stash-item').click()
    await expect(page.getByTestId('stash-message')).toHaveText('half-done edit')
    await expect(page.getByTestId('stash-files')).toContainText('a.txt')
    await expect(page.getByTestId('stash-files')).toContainText('new.txt')

    await page.getByTestId('stash-panel').getByRole('button', { name: 'Pop' }).click()
    await expect(page.getByTestId('stash-item')).toHaveCount(0)
    expect(read(repo, 'a.txt')).toBe('edited\n')
    expect(read(repo, 'new.txt')).toBe('brand new\n')
  } finally {
    await app.close()
  }
})

test('creates an annotated tag and deletes it with confirmation', async () => {
  const repo = createFixtureRepo()
  const first = repo.commit('first', { 'a.txt': '1' })
  repo.commit('second', { 'a.txt': '2' })
  const { app, page } = await launch(repo.dir)
  try {
    await row(page, 'first').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Create tag here…' }).click()
    await page.getByLabel('Tag name').fill('v1.0.0')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByLabel(/Message/).fill('First release')
    await page.getByRole('button', { name: 'Create tag' }).click()

    await expect(row(page, 'first').locator('[data-ref="refs/tags/v1.0.0"]')).toBeVisible()
    expect(repo.git(['rev-parse', 'v1.0.0^{commit}'])).toBe(first)
    expect(repo.git(['cat-file', '-t', 'v1.0.0'])).toBe('tag')

    await mockConfirm(app, 1)
    await page.locator('[data-testid="ref-item"][data-ref="refs/tags/v1.0.0"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Delete tag v1.0.0/ }).click()
    await expect(page.locator('[data-testid="ref-item"][data-ref="refs/tags/v1.0.0"]')).toHaveCount(0)
    expect(repo.git(['tag', '--list'])).toBe('')
  } finally {
    await app.close()
  }
})

test('cherry-pick conflict shows the operation banner and can be aborted', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'f.txt': 'base\n' })
  repo.branch('other')
  repo.commit('ours', { 'f.txt': 'ours\n' })
  repo.checkout('other')
  repo.commit('theirs change', { 'f.txt': 'theirs\n' })
  repo.checkout('main')
  const head = repo.head()
  const { app, page } = await launch(repo.dir)
  try {
    await row(page, 'theirs change').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Cherry-pick this commit' }).click()
    await expect(page.getByTestId('error-message')).toContainText('conflicts')
    await expect(page.getByTestId('operation-banner')).toContainText('Cherry-pick in progress')
    await expect(page.getByTestId('operation-banner')).toContainText('1 conflicted file')

    await mockConfirm(app, 1)
    await page.getByTestId('operation-banner').getByRole('button', { name: 'Abort…' }).click()
    await expect(page.getByTestId('operation-banner')).toHaveCount(0)
    expect(repo.head()).toBe(head)
    expect(read(repo, 'f.txt')).toBe('ours\n')
  } finally {
    await app.close()
  }
})

test('cherry-pick and revert without conflicts create commits', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': 'a\n' })
  repo.branch('other')
  repo.checkout('other')
  repo.commit('add b', { 'b.txt': 'b\n' })
  repo.checkout('main')
  repo.commit('add c', { 'c.txt': 'c\n' })
  const { app, page } = await launch(repo.dir)
  try {
    await row(page, 'add b').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Cherry-pick this commit' }).click()
    await expect(page.getByTestId('commit-row').first()).toContainText('add b')
    expect(read(repo, 'b.txt')).toBe('b\n')

    await row(page, 'add c').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Revert this commit' }).click()
    await expect(page.getByTestId('commit-row').first()).toContainText('Revert "add c"')
    expect(repo.git(['ls-files'])).not.toContain('c.txt')
  } finally {
    await app.close()
  }
})

test('hard reset asks first and saves uncommitted changes as a backup stash', async () => {
  const repo = createFixtureRepo()
  const first = repo.commit('first', { 'a.txt': '1\n' })
  repo.commit('second', { 'a.txt': '2\n' })
  repo.write('a.txt', 'precious uncommitted work\n')
  const { app, page } = await launch(repo.dir)
  try {
    // Declining changes nothing.
    await mockConfirm(app, 0)
    await row(page, 'first').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /hard: discard changes/ }).click()
    await page.waitForTimeout(300)
    expect(read(repo, 'a.txt')).toBe('precious uncommitted work\n')

    await mockConfirm(app, 1)
    await row(page, 'first').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /hard: discard changes/ }).click()
    await expect(page.getByTestId('notice')).toContainText('backup stash')
    expect(repo.head()).toBe(first)
    expect(read(repo, 'a.txt')).toBe('1\n')

    // The work is recoverable from the listed backup stash.
    await expect(page.getByTestId('stash-item')).toContainText('GitBob: backup before hard reset')
    await page.getByTestId('stash-item').click()
    await page.getByTestId('stash-panel').getByRole('button', { name: 'Apply' }).click()
    // The backup was taken on top of "second", so applying it onto "first" conflicts;
    // the work is restored inside the conflict markers and the conflict is reported.
    await expect.poll(() => read(repo, 'a.txt')).toContain('precious uncommitted work')
    await expect(page.getByTestId('error-message')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('reflog finds a commit lost by a hard reset and rescues it as a branch', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1\n' })
  const lost = repo.commit('precious work', { 'a.txt': '2\n' })
  repo.git(['reset', '-q', '--hard', 'HEAD~1'])
  const { app, page } = await launch(repo.dir)
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(1)
    await page.getByTestId('reflog').getByRole('button', { name: /Reflog/ }).click()
    const entry = page.locator(`[data-testid="reflog-item"][data-sha="${lost}"]`).first()
    await expect(entry).toContainText('precious work')

    await entry.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Create branch here…' }).click()
    await page.getByLabel('Branch name').fill('rescued')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('head-label')).toHaveText('rescued')
    expect(repo.rev('rescued')).toBe(lost)
  } finally {
    await app.close()
  }
})

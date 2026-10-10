import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir, type FixtureRepo } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')

async function launch(repo: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = makeTempDir('gitbob-ud-')
  const app = await electron.launch({
    args: [appDir, repo],
    env: {
      ...process.env,
      GITBOB_USER_DATA: userData,
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
  // Start every test from the unified view regardless of a remembered preference.
  await page.evaluate(() => localStorage.removeItem('gitbob.diffMode'))
  return { app, page }
}

const mockConfirm = (app: ElectronApplication, response: number) =>
  app.evaluate(({ dialog }, r) => {
    dialog.showMessageBox = (() => Promise.resolve({ response: r, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, response)

const fileRow = (page: Page, section: string, path: string) =>
  page.getByTestId(section).locator(`[data-testid="status-file"][data-path="${path}"]`)

/** 20-line file so two edits produce two separate hunks. */
const lines = (edit: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

const read = (repo: FixtureRepo, p: string) => readFileSync(join(repo.dir, p), 'utf8')

test.afterAll(cleanupFixtures)

test('side-by-side diff renders both versions with Monaco', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'app.ts': 'export const a = 1\nexport const b = 2\n' })
  repo.write('app.ts', 'export const a = 1\nexport const b = 3\nexport const c = 4\n')
  const { app, page } = await launch(repo.dir)
  try {
    await page.getByTestId('wip-row').click()
    await fileRow(page, 'unstaged-files', 'app.ts').click()
    await page.getByRole('button', { name: 'Side by side' }).click()
    const editor = page.getByTestId('side-by-side-diff')
    await expect(editor.locator('.monaco-diff-editor')).toBeVisible()
    await expect(editor.locator('.editor.original')).toContainText('export const b = 2')
    await expect(editor.locator('.editor.modified')).toContainText('export const c = 4')
    // The choice is remembered.
    expect(await page.evaluate(() => localStorage.getItem('gitbob.diffMode'))).toBe('split')
  } finally {
    await app.close()
  }
})

test('stages a single hunk and single lines, unstages and discards hunks', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'f.txt': lines() })
  repo.write('f.txt', lines({ 2: 'CHANGED two', 18: 'CHANGED eighteen' }))
  const { app, page } = await launch(repo.dir)
  try {
    await page.getByTestId('wip-row').click()
    await fileRow(page, 'unstaged-files', 'f.txt').click()
    await expect(page.getByTestId('hunk-header')).toHaveCount(2)

    // Stage only the first hunk.
    await page.getByTestId('hunk-header').first().getByRole('button', { name: 'Stage hunk' }).click()
    await expect(page.getByTestId('hunk-header')).toHaveCount(1)
    const cached = repo.git(['diff', '--cached'])
    expect(cached).toContain('+CHANGED two')
    expect(cached).not.toContain('CHANGED eighteen')

    // Discard the remaining unstaged hunk (confirmed natively).
    await mockConfirm(app, 1)
    await page.getByTestId('hunk-header').first().getByRole('button', { name: 'Discard hunk' }).click()
    await expect(page.getByTestId('diff-empty').or(page.getByTestId('hunk-header'))).toBeVisible()
    await expect.poll(() => read(repo, 'f.txt')).toBe(lines({ 2: 'CHANGED two' }))

    // Unstage it again from the staged view.
    await fileRow(page, 'staged-files', 'f.txt').click()
    await page.getByTestId('hunk-header').first().getByRole('button', { name: 'Unstage hunk' }).click()
    await expect.poll(() => repo.git(['diff', '--cached'])).toBe('')
  } finally {
    await app.close()
  }
})

test('stages selected lines from a hunk', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'f.txt': lines() })
  repo.write('f.txt', lines({ 5: 'five A', 6: 'six B' }))
  const { app, page } = await launch(repo.dir)
  try {
    await page.getByTestId('wip-row').click()
    await fileRow(page, 'unstaged-files', 'f.txt').click()
    // Select only "+five A" (and its "-line 5").
    await page.locator('tr[data-line-type="del"]', { hasText: 'line 5' }).click()
    await page.locator('tr[data-line-type="add"]', { hasText: 'five A' }).click()
    await page.getByRole('button', { name: 'Stage 2 lines' }).click()
    await expect.poll(() => repo.git(['show', ':f.txt'])).toBe(lines({ 5: 'five A' }).trimEnd())
    expect(read(repo, 'f.txt')).toBe(lines({ 5: 'five A', 6: 'six B' }))
  } finally {
    await app.close()
  }
})

test('resolves a merge conflict in the conflict editor and finishes the merge', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'c.txt': 'top\nshared\nbottom\n' })
  repo.branch('other')
  repo.commit('ours change', { 'c.txt': 'top\nours version\nbottom\n' })
  repo.checkout('other')
  repo.commit('theirs change', { 'c.txt': 'top\ntheirs version\nbottom\n' })
  repo.checkout('main')
  try {
    repo.git(['merge', 'other', '-m', 'Merge other'])
  } catch {
    /* expected conflict */
  }
  const { app, page } = await launch(repo.dir)
  try {
    await expect(page.getByTestId('operation-banner')).toContainText('Merge in progress')
    await page.getByTestId('wip-row').click()
    await fileRow(page, 'conflicted-files', 'c.txt').click()

    const editor = page.getByTestId('conflict-editor')
    await expect(editor.getByTestId('conflict-ours')).toContainText('ours version')
    await expect(editor.getByTestId('conflict-theirs')).toContainText('theirs version')
    await expect(editor.getByTestId('conflict-count')).toHaveText('1 conflict left')
    await expect(editor.getByRole('button', { name: 'Save and mark resolved' })).toBeDisabled()

    await editor.getByTestId('conflict-chunk').getByRole('button', { name: 'Both' }).click()
    await expect(editor.getByTestId('conflict-count')).toHaveText('All conflicts resolved')
    await editor.getByRole('button', { name: 'Save and mark resolved' }).click()

    await expect(page.getByTestId('conflict-editor')).toHaveCount(0)
    expect(read(repo, 'c.txt')).toBe('top\nours version\ntheirs version\nbottom\n')
    expect(repo.git(['ls-files', '-u'])).toBe('')

    await page.getByTestId('operation-banner').getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByTestId('operation-banner')).toHaveCount(0)
    expect(repo.git(['rev-list', '--parents', '-n1', 'HEAD']).split(' ')).toHaveLength(3)
  } finally {
    await app.close()
  }
})

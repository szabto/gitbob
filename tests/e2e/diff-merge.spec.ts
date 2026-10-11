import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
/** For polling: git rewrites files by delete + create, so a read can briefly find nothing. */
const readSoon = (repo: FixtureRepo, p: string): string | null => {
  try {
    return read(repo, p)
  } catch {
    return null
  }
}

test.afterAll(cleanupFixtures)

test('side-by-side diff renders both versions with Monaco', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'app.ts': 'export const a = 1\nexport const b = 2\n' })
  repo.write('app.ts', 'export const a = 1\nexport const b = 3\nexport const c = 4\n')
  const { app, page } = await launch(repo.dir)
  try {
    await page.getByTestId('wip-row').click()
    await fileRow(page, 'unstaged-files', 'app.ts').click()
    // Side by side needs room; CI screens can be small, so size the window explicitly.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 1000))
    await page.getByRole('button', { name: 'Side by side' }).click()
    const editor = page.getByTestId('side-by-side-diff')
    await expect(editor.locator('.monaco-diff-editor')).toBeVisible()
    await expect(editor.locator('.editor.original')).toBeVisible()
    await expect(editor.locator('.editor.original')).toContainText('export const b = 2')
    // Really side by side: the original pane is left of the modified pane.
    const [o, m] = await Promise.all([
      editor.locator('.editor.original').boundingBox(),
      editor.locator('.editor.modified').boundingBox(),
    ])
    expect(o!.width).toBeGreaterThan(100)
    expect(o!.x + o!.width).toBeLessThanOrEqual(m!.x + 1)
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
    await expect.poll(() => readSoon(repo, 'f.txt')).toBe(lines({ 2: 'CHANGED two' }))

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

test('a binary conflict is resolved by keeping one whole version', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'logo.png': Buffer.from([0x89, 0x50, 0, 1, 2, 3]) })
  repo.branch('other')
  repo.commit('ours logo', { 'logo.png': Buffer.from([0x89, 0x50, 0, 9, 9, 9]) })
  repo.checkout('other')
  repo.commit('theirs logo', { 'logo.png': Buffer.from([0x89, 0x50, 0, 7, 7, 7]) })
  repo.checkout('main')
  try {
    repo.git(['merge', 'other', '-m', 'Merge other'])
  } catch {
    /* expected conflict */
  }
  const { app, page } = await launch(repo.dir)
  try {
    await page.getByTestId('wip-row').click()
    await fileRow(page, 'conflicted-files', 'logo.png').click()
    const choice = page.getByTestId('whole-file-conflict')
    await expect(choice).toContainText('binary file')
    await mockConfirm(app, 1)
    await choice.getByRole('button', { name: /^Keep the .* version$/ }).last().click()
    await expect(page.getByTestId('whole-file-conflict')).toHaveCount(0)
    expect(repo.git(['ls-files', '-u'])).toBe('')
    expect([...readFileSync(join(repo.dir, 'logo.png'))]).toEqual([0x89, 0x50, 0, 7, 7, 7])
  } finally {
    await app.close()
  }
})

test('a staged rename shows as old → new with its content change', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'old-name.txt': lines() })
  repo.git(['mv', 'old-name.txt', 'new-name.txt'])
  repo.write('new-name.txt', lines({ 5: 'renamed and edited' }))
  repo.git(['add', 'new-name.txt'])
  const { app, page } = await launch(repo.dir)
  try {
    await page.getByTestId('wip-row').click()
    await fileRow(page, 'staged-files', 'new-name.txt').click()
    await expect(page.getByTestId('diff-path')).toContainText('old-name.txt → new-name.txt')
    await expect(page.getByTestId('diff-table')).toContainText('renamed and edited')
    await expect(page.getByTestId('diff-table')).not.toContainText('line 15')
  } finally {
    await app.close()
  }
})

test('a repository using LFS without git-lfs installed shows a warning', async () => {
  test.skip(spawnSync('git', ['lfs', 'version']).status === 0, 'git-lfs is installed here')
  const repo = createFixtureRepo()
  repo.commit('lfs', { '.gitattributes': '*.psd filter=lfs diff=lfs merge=lfs -text\n' })
  const { app, page } = await launch(repo.dir)
  try {
    const lfs = page.getByTestId('lfs')
    await expect(lfs.getByTestId('lfs-missing')).toContainText('git-lfs isn’t installed')
  } finally {
    await app.close()
  }
})

test('edit a file in the app, save and stage it, and refuse to overwrite outside changes', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'notes.txt': 'first line\n' })
  repo.write('notes.txt', 'first line\nsecond line\n')
  const { app, page } = await launch(repo.dir)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  // Wait for the file to be in the editor, put the cursor at its very end, type, and check it landed.
  const typeAtEnd = async (text: string, expectLoaded: string) => {
    const lines = page.locator('[data-testid="file-editor-monaco"] .view-lines')
    await expect(lines).toContainText(expectLoaded)
    await lines.locator('.view-line').last().click()
    await page.keyboard.press(`${mod}+End`)
    await page.keyboard.type(text)
    await expect(lines).toContainText(text.trim())
  }
  try {
    await page.getByTestId('wip-row').click()
    await fileRow(page, 'unstaged-files', 'notes.txt').click()
    await page.getByTestId('diff-view').getByRole('button', { name: 'Edit' }).click()
    const editor = page.getByTestId('file-editor')
    await expect(editor.locator('.monaco-editor')).toBeVisible()
    await typeAtEnd('third line\n', 'second line')
    await expect(editor).toContainText('unsaved')
    await editor.getByRole('button', { name: 'Save and stage' }).click()
    await expect(page.getByTestId('notice')).toContainText('Saved and staged notes.txt')
    expect(read(repo, 'notes.txt')).toBe('first line\nsecond line\nthird line\n')
    expect(repo.git(['diff', '--cached', '--name-only'])).toBe('notes.txt')

    // Another program changes the file while it is open: saving is refused, nothing is lost.
    repo.write('notes.txt', 'first line\nsecond line\nthird line\nfrom elsewhere\n')
    await page.locator('[data-testid="unstaged-files"] [data-path="notes.txt"]').click()
    repo.write('notes.txt', 'changed again outside\n')
    await page.getByTestId('diff-view').getByRole('button', { name: 'Edit' }).click()
    await expect(editor.locator('.monaco-editor')).toBeVisible()
    repo.write('notes.txt', 'and once more\n')
    await typeAtEnd('mine\n', 'changed again outside')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('error-message')).toContainText('changed outside GitBob')
    expect(read(repo, 'notes.txt')).toBe('and once more\n')

    // Cancelling with unsaved edits asks first.
    await editor.getByRole('button', { name: 'Cancel' }).click()
    await editor.getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByTestId('file-editor')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

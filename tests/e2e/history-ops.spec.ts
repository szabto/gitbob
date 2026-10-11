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

test('undo and redo a commit, a new branch and a branch delete; stale history is refused', async () => {
  const repo = createFixtureRepo()
  const base = repo.commit('base', { 'a.txt': '1\n' })
  repo.branch('old-feature')
  repo.write('a.txt', '2\n')
  const { app, page } = await launch(repo.dir)
  const undo = page.getByRole('button', { name: 'Undo', exact: true })
  const redo = page.getByRole('button', { name: 'Redo', exact: true })
  try {
    await expect(undo).toBeDisabled()

    // Commit, then undo: the commit is gone and its changes are staged again.
    await page.getByTestId('wip-row').click()
    await page.getByRole('button', { name: 'Stage all' }).click()
    await page.getByLabel('Commit summary').fill('Change a')
    await page.getByRole('button', { name: /^Commit/ }).click()
    await expect(row(page, 'Change a')).toBeVisible()
    await expect(undo).toHaveAttribute('title', 'Undo: Commit "Change a"')
    await undo.click()
    await expect(page.getByTestId('notice')).toContainText('Undid: Commit "Change a"')
    await expect(row(page, 'Change a')).toHaveCount(0)
    expect(repo.head()).toBe(base)
    expect(repo.git(['diff', '--cached', '--name-only'])).toBe('a.txt')
    await redo.click()
    await expect(row(page, 'Change a')).toBeVisible()
    expect(repo.git(['log', '-1', '--format=%s'])).toBe('Change a')
    expect(repo.git(['status', '--porcelain'])).toBe('')

    // New branch (checked out), undo: back on main and the branch is gone.
    await page.getByRole('button', { name: 'Branch', exact: true }).click()
    await page.getByLabel('Branch name').fill('feature/x')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('head-label')).toHaveText('feature/x')
    await undo.click()
    await expect(page.getByTestId('head-label')).toHaveText('main')
    expect(repo.git(['branch', '--list', 'feature/x'])).toBe('')

    // Delete a branch (confirmed), undo brings it back at the same commit.
    await mockConfirm(app, 1)
    await page.locator('[data-testid="ref-item"][data-ref="refs/heads/old-feature"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Delete old-feature/ }).click()
    await expect(page.locator('[data-testid="ref-item"][data-ref="refs/heads/old-feature"]')).toHaveCount(0)
    await undo.click()
    await expect(page.locator('[data-testid="ref-item"][data-ref="refs/heads/old-feature"]')).toBeVisible()
    expect(repo.rev('old-feature')).toBe(base)

    // Something changed outside GitBob: redo refuses instead of guessing.
    await expect(redo).toBeEnabled()
    const moved = repo.commit('made in a terminal', { 'b.txt': 'x\n' })
    repo.git(['update-ref', 'refs/heads/old-feature', moved])
    await redo.click()
    await expect(page.getByTestId('error-message')).toContainText('repository has changed')
    expect(repo.rev('old-feature')).toBe(moved)
    await page.getByRole('button', { name: 'Dismiss error' }).click()
    await expect(undo).toBeDisabled()
    await expect(redo).toBeDisabled()
  } finally {
    await app.close()
  }
})

test('stash one file, view an untracked stashed file, apply a single file, and turn a stash into a branch', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': 'one\n', 'b.txt': 'bee\n' })
  repo.write('a.txt', 'edited a\n')
  repo.write('b.txt', 'edited b\n')
  repo.write('new.txt', 'brand new\n')
  const { app, page } = await launch(repo.dir)
  const status = (path: string) => page.locator(`[data-testid="unstaged-files"] [data-path="${path}"]`)
  try {
    // Stash only a.txt from its context menu.
    await page.getByTestId('wip-row').click()
    await status('a.txt').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Stash a.txt…' }).click()
    await page.getByLabel('Message (optional)').fill('just a')
    await page.getByRole('button', { name: 'Stash', exact: true }).click()
    await expect(page.getByTestId('stash-item')).toHaveText('just a')
    expect(read(repo, 'a.txt')).toBe('one\n')
    expect(read(repo, 'b.txt')).toBe('edited b\n')

    // Stash the rest (with the untracked file); its diff shows in the panel.
    await page.getByRole('button', { name: 'Stash…' }).click()
    await page.getByLabel('Message (optional)').fill('the rest')
    await page.getByRole('button', { name: 'Stash', exact: true }).click()
    await expect(page.getByTestId('stash-item')).toHaveCount(2)
    await page.getByTestId('stash-item').filter({ hasText: 'the rest' }).click()
    await page.locator('[data-testid="stash-file"][data-path="new.txt"]').click()
    await expect(page.getByTestId('diff-table')).toContainText('brand new')

    // Bring back only b.txt; the stash stays.
    await page.locator('[data-testid="stash-file"][data-path="b.txt"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Apply only b.txt' }).click()
    await expect(page.getByTestId('notice')).toContainText('Restored b.txt')
    expect(read(repo, 'b.txt')).toBe('edited b\n')
    await expect(page.getByTestId('stash-item')).toHaveCount(2)

    // Turn "just a" into a branch.
    await page.getByTestId('stash-item').filter({ hasText: 'just a' }).click()
    await page.getByTestId('stash-panel').getByRole('button', { name: 'Branch…' }).click()
    await page.getByLabel('Branch name').fill('rescue-a')
    await page.getByRole('button', { name: 'Create branch' }).click()
    // b.txt is modified locally, but stash branch only touches a.txt.
    await expect(page.getByTestId('head-label')).toHaveText('rescue-a')
    expect(read(repo, 'a.txt')).toBe('edited a\n')
    await expect(page.getByTestId('stash-item')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

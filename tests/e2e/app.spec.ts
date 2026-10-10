import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir, type FixtureRepo } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')

async function launch(opts: { repo?: string; userData: string }): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, ...(opts.repo ? [opts.repo] : [])],
    env: { ...process.env, GITBOB_USER_DATA: opts.userData, ELECTRON_RENDERER_URL: '' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** main: root - m1 - merge(feature) - m3 ; feature: f1 - f2 ; tag v1.0 on m1; extra branch "wip" not merged. */
function buildRepo(): { repo: FixtureRepo; shas: Record<string, string> } {
  const repo = createFixtureRepo()
  const shas: Record<string, string> = {}
  shas.root = repo.commit('Initial commit', { 'README.md': '# demo\n' })
  shas.m1 = repo.commit('Add app source', { 'src/app.ts': 'export const a = 1\n' })
  repo.tag('v1.0', { annotated: true })
  repo.branch('feature')
  repo.checkout('feature')
  shas.f1 = repo.commit('Feature part one', { 'src/feature.ts': 'export const f = 1\n' })
  shas.f2 = repo.commit('Feature part two', { 'src/feature.ts': 'export const f = 2\n' })
  repo.checkout('main')
  shas.m2 = repo.commit('Main work', { 'src/app.ts': 'export const a = 2\n' })
  shas.merge = repo.merge('feature', 'Merge branch feature')
  shas.m3 = repo.commit('Polish\n\nLonger description of the polish.', { 'docs/notes.md': 'notes\n' })
  repo.branch('wip', shas.m2)
  repo.checkout('wip')
  shas.wip = repo.commit('Work in progress', { 'wip.txt': 'wip\n' })
  repo.checkout('main')
  return { repo, shas }
}

test.afterAll(cleanupFixtures)

test('opens a repository from the command line and renders its real history graph', async () => {
  const { repo, shas } = buildRepo()
  const { app, page } = await launch({ repo: repo.dir, userData: makeTempDir('gitbob-ud-') })
  try {
    await expect(page.getByTestId('repo-name')).toHaveText(repo.dir.split('/').pop()!)
    await expect(page.getByTestId('head-label')).toHaveText('main')

    const rows = page.getByTestId('commit-row')
    await expect(rows).toHaveCount(8)
    await expect(page.getByTestId('commit-count')).toHaveText('8 commits')

    // Row order must match git's date order, newest first.
    const expected = repo.git(['log', '--date-order', '--format=%H', '--branches', '--tags', 'HEAD']).split('\n')
    const actual = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-sha')))
    expect(actual).toEqual(expected)

    // Ref labels on the right commits.
    await expect(page.locator(`[data-sha="${shas.m3}"] [data-ref="refs/heads/main"]`)).toBeVisible()
    await expect(page.locator(`[data-sha="${shas.f2}"] [data-ref="refs/heads/feature"]`)).toBeVisible()
    await expect(page.locator(`[data-sha="${shas.wip}"] [data-ref="refs/heads/wip"]`)).toBeVisible()
    await expect(page.locator(`[data-sha="${shas.m1}"] [data-ref="refs/tags/v1.0"]`)).toBeVisible()

    // The graph uses more than one lane for the feature branch.
    const columns = await page.locator('[data-testid="commit-row"] svg').evaluateAll((els) =>
      els.map((e) => Number(e.getAttribute('data-column'))),
    )
    expect(Math.max(...columns)).toBeGreaterThanOrEqual(1)

    // Sidebar lists branches and tags.
    await expect(page.getByTestId('local-branches')).toContainText('feature')
    await expect(page.getByTestId('local-branches')).toContainText('wip')
    await expect(page.getByTestId('tags')).toContainText('v1.0')

    // Selecting a commit shows its real details.
    await page.locator(`[data-sha="${shas.m3}"]`).click()
    await expect(page.getByTestId('details-subject')).toHaveText('Polish')
    await expect(page.getByTestId('details-body')).toHaveText('Longer description of the polish.')
    await expect(page.getByTestId('details-sha')).toHaveText(shas.m3!)
    await expect(page.getByTestId('details-files')).toContainText('docs/notes.md')

    // Keyboard navigation moves the selection down the list.
    await page.getByTestId('commit-graph').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-testid="commit-row"][aria-selected="true"]')).toHaveAttribute(
      'data-sha',
      expected[expected.indexOf(shas.m3!) + 1]!,
    )

    // Clicking a branch in the sidebar selects its tip commit.
    await page.getByTestId('local-branches').getByText('feature').click()
    await expect(page.getByTestId('details-subject')).toHaveText('Feature part two')
  } finally {
    await app.close()
  }
})

test('opens a repository via the dialog, remembers it, and reports invalid folders', async () => {
  const { repo } = buildRepo()
  const notRepo = makeTempDir('gitbob-notrepo-')
  const userData = makeTempDir('gitbob-ud-')

  let { app, page } = await launch({ userData })
  try {
    await expect(page.getByText('No recent repositories.')).toBeVisible()

    // Invalid folder: the error must be surfaced, not swallowed.
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
    }, notRepo)
    await page.getByRole('button', { name: 'Open Repository…' }).click()
    await expect(page.getByTestId('error-message')).toContainText('Not a Git repository')

    // Valid repository.
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
    }, repo.dir)
    await page.getByRole('button', { name: 'Open Repository…' }).click()
    await expect(page.getByTestId('commit-row')).toHaveCount(8)
    await expect(page.getByTestId('error-message')).toHaveCount(0)
  } finally {
    await app.close()
  }

  // The repository is listed under recents after a restart and can be reopened.
  ;({ app, page } = await launch({ userData }))
  try {
    const recent = page.getByRole('button', { name: new RegExp(repo.dir.split('/').pop()!) })
    await expect(recent).toBeVisible()
    await recent.click()
    await expect(page.getByTestId('commit-row')).toHaveCount(8)
  } finally {
    await app.close()
  }
})

test('shows an empty state for a repository without commits', async () => {
  const repo = createFixtureRepo()
  const { app, page } = await launch({ repo: repo.dir, userData: makeTempDir('gitbob-ud-') })
  try {
    await expect(page.getByTestId('empty-history')).toBeVisible()
    await expect(page.getByTestId('head-label')).toHaveText('main (no commits)')
  } finally {
    await app.close()
  }
})

test('renderer is sandboxed with no Node access', async () => {
  const { app, page } = await launch({ userData: makeTempDir('gitbob-ud-') })
  try {
    const probe = await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      process: typeof (globalThis as Record<string, unknown>).process,
      bridge: Object.keys(window.gitbob).sort(),
    }))
    expect(probe).toEqual({ require: 'undefined', process: 'undefined', bridge: ['invoke', 'on', 'platform'] })

    // Unknown channels are rejected by the preload allowlist.
    const err = await page.evaluate(() => window.gitbob.invoke('evil:channel', {}).then(() => 'ok', (e: Error) => e.message))
    expect(err).toContain('Unknown IPC channel')

    // Repository-scoped calls for repositories that were never opened are refused by main.
    const res = await page.evaluate(() => window.gitbob.invoke('repo:refs', { repoPath: '/' }))
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })

    // Malformed input is rejected by schema validation.
    const bad = await page.evaluate(() => window.gitbob.invoke('commit:details', { repoPath: '/x', sha: '--all' }))
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  } finally {
    await app.close()
  }
})

test('searches the whole history and steps through matches', async () => {
  const { repo, shas } = buildRepo()
  const { app, page } = await launch({ repo: repo.dir, userData: makeTempDir('gitbob-ud-') })
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(8)
    await page.getByTestId('commit-graph').focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+F' : 'Control+F')
    await expect(page.getByLabel('Search history')).toBeFocused()
    await page.keyboard.type('feature part')
    await expect(page.getByTestId('search-count')).toHaveText('1 of 2')
    await expect(page.locator('[data-testid="commit-row"][data-match="true"]')).toHaveCount(2)

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('details-subject')).toHaveText('Feature part two')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('details-subject')).toHaveText('Feature part one')
    await expect(page.getByTestId('search-count')).toHaveText('2 of 2')
    await page.keyboard.press('Shift+Enter')
    await expect(page.getByTestId('details-sha')).toHaveText(shas.f2!)

    // Author search and no-match state.
    await page.getByLabel('Search history').fill('test author')
    await expect(page.getByTestId('search-count')).toHaveText('1 of 8')
    await page.getByLabel('Search history').fill('zzz-nothing')
    await expect(page.getByTestId('search-count')).toHaveText('No matches')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="commit-row"][data-match="true"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

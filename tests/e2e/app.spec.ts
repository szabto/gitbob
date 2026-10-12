import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { basename, resolve } from 'node:path'
import { openAllSidebarSections } from '../helpers/ui'
import { cleanupFixtures, createFixtureRepo, makeTempDir, type FixtureRepo } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')

async function launch(opts: { repo?: string; userData: string }): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appDir, ...(opts.repo ? [opts.repo] : [])],
    env: { ...process.env, GITBOB_USER_DATA: opts.userData, ELECTRON_RENDERER_URL: '' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (opts.repo) await openAllSidebarSections(page)
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
    await expect(page.getByTestId('repo-name')).toHaveText(basename(repo.dir))
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

  // After a restart the tab is restored, and the repository is listed under recents in a new tab.
  ;({ app, page } = await launch({ userData }))
  try {
    await expect(page.getByTestId('repo-tab')).toHaveCount(1)
    await expect(page.getByTestId('commit-row')).toHaveCount(8)
    await page.getByRole('button', { name: 'New tab' }).click()
    const recent = page.getByTestId('recent-repo').filter({ hasText: basename(repo.dir) })
    await expect(recent).toBeVisible()
    await recent.click()
    await expect(page.getByTestId('repo-tab')).toHaveCount(1)
    await expect(page.getByTestId('commit-row')).toHaveCount(8)
  } finally {
    await app.close()
  }
})

test('opens several repositories in tabs, switches and closes them', async () => {
  const a = buildRepo().repo
  const b = createFixtureRepo()
  b.commit('only commit in b', { 'b.txt': 'b' })
  const { app, page } = await launch({ repo: a.dir, userData: makeTempDir('gitbob-ud-') })
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(8)
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
    }, b.dir)
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('button', { name: 'Open Repository…' }).click()
    await expect(page.getByTestId('repo-tab')).toHaveCount(2)
    await expect(page.getByTestId('commit-row')).toHaveCount(1)

    // Switch back to the first tab.
    await page.getByTestId('repo-tab').first().click()
    await expect(page.getByTestId('commit-row')).toHaveCount(8)

    // Live refresh follows the visible tab.
    a.write('new.txt', 'x')
    await expect(page.getByTestId('wip-row')).toBeVisible({ timeout: 10_000 })

    // Close the active tab: the other one becomes active.
    await page.getByRole('button', { name: `Close ${basename(a.dir)}` }).click()
    await expect(page.getByTestId('repo-tab')).toHaveCount(1)
    await expect(page.getByTestId('commit-row')).toHaveCount(1)
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

    // Test runs never show windows or take focus (GITBOB_HIDDEN, set in playwright.config.ts).
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false])

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

test('View > Theme switches between dark and light and persists', async () => {
  const userData = makeTempDir('gitbob-ud-')
  const clickTheme = (app: ElectronApplication, label: string) =>
    app.evaluate(({ Menu }, l) => {
      const view = Menu.getApplicationMenu()!.items.find((i) => i.label === 'View')!
      const theme = view.submenu!.items.find((i) => i.label === 'Theme')!
      theme.submenu!.items.find((i) => i.label === l)!.click()
    }, label)
  const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  let { app, page } = await launch({ userData })
  try {
    await expect(page.getByText('No recent repositories.')).toBeVisible()
    await clickTheme(app, 'Dark')
    await expect.poll(() => bg(page)).toBe('rgb(15, 17, 21)')
    await clickTheme(app, 'Light')
    await expect.poll(() => bg(page)).toBe('rgb(255, 255, 255)')
  } finally {
    await app.close()
  }
  // The choice survives a restart.
  ;({ app, page } = await launch({ userData }))
  try {
    await expect.poll(() => bg(page)).toBe('rgb(255, 255, 255)')
  } finally {
    await app.close()
  }
})

test('branches are shown as a tree that can be collapsed', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1' })
  repo.branch('feature/login')
  repo.branch('feature/ui/dark')
  repo.branch('fix/typo')
  const userData = makeTempDir('gitbob-ud-')
  let { app, page } = await launch({ repo: repo.dir, userData })
  try {
    const local = page.getByTestId('local-branches')
    await expect(local.locator('[data-testid="ref-folder"][data-folder="feature"]')).toBeVisible()
    await expect(local.locator('[data-testid="ref-folder"][data-folder="feature/ui"]')).toBeVisible()
    const leaf = local.locator('[data-ref="refs/heads/feature/ui/dark"]')
    await expect(leaf).toHaveText('dark')

    await local.locator('[data-folder="feature"]').click()
    await expect(leaf).toHaveCount(0)
    await expect(local.locator('[data-ref="refs/heads/fix/typo"]')).toBeVisible()
  } finally {
    await app.close()
  }
  ;({ app, page } = await launch({ repo: repo.dir, userData }))
  try {
    await expect(page.getByTestId('local-branches').locator('[data-folder="feature"]')).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await app.close()
  }
})

test('branch labels: one label when local and remote match, two when they differ; columns and WIP counts', async () => {
  const seed = createFixtureRepo()
  seed.commit('base', { 'a.txt': '1\n', 'gone.txt': 'x\n' })
  seed.branch('feature')
  const server = createFixtureRepo({ bare: true })
  seed.git(['push', '-q', server.dir, 'main', 'feature'])
  const repo = createFixtureRepo()
  repo.git(['remote', 'add', 'origin', server.dir])
  repo.git(['fetch', '-q', 'origin'])
  repo.git(['switch', '-q', '-c', 'main', '--track', 'origin/main'])
  repo.git(['branch', '-q', '--track', 'feature', 'origin/feature'])
  const ahead = repo.commit('local only', { 'a.txt': '2\n' })
  repo.write('new.txt', 'n\n')
  repo.write('a.txt', '3\n')
  repo.git(['rm', '-q', 'gone.txt'])
  const { app, page } = await launch({ repo: repo.dir, userData: makeTempDir('gitbob-ud-') })
  const label = (ref: string) => page.locator(`[data-testid="ref-label"][data-ref="${ref}"]`)
  try {
    // main is ahead of origin/main: the local label (laptop, checked out) is on the new commit…
    const main = label('refs/heads/main')
    await expect(main).toHaveAttribute('data-local', 'true')
    await expect(main).not.toHaveAttribute('data-remotes', /./)
    await expect(main).toContainText('✓')
    await expect(page.locator(`[data-testid="commit-row"][data-sha="${ahead}"] [data-testid="ref-label"]`)).toHaveCount(1)
    // …and the remote one sits on the older commit, named without the remote prefix.
    const remoteMain = label('refs/remotes/origin/main')
    await expect(remoteMain).toHaveAttribute('data-remotes', 'origin')
    await expect(remoteMain).toContainText('main')
    // feature matches origin/feature: a single label with both the laptop and the remote icon.
    const feature = label('refs/heads/feature')
    await expect(feature).toHaveAttribute('data-local', 'true')
    await expect(feature).toHaveAttribute('data-remotes', 'origin')
    await expect(label('refs/remotes/origin/feature')).toHaveCount(0)
    await expect(feature.getByRole('img', { name: 'on this computer' })).toBeVisible()
    await expect(feature.getByRole('img', { name: 'on origin' })).toBeVisible()

    // Author initials stand in for avatars (no hosting service here).
    await expect(page.getByTestId('avatar-node').first()).toBeVisible()

    // WIP row shows modified / new / deleted counts.
    await expect(page.getByTestId('wip-kinds')).toContainText('✎ 1')
    await expect(page.getByTestId('wip-kinds')).toContainText('+ 1')
    await expect(page.getByTestId('wip-kinds')).toContainText('− 1')

    // Columns can be hidden from the header menu, and that is remembered.
    await page.getByRole('button', { name: 'Choose columns' }).click()
    await page.getByRole('menuitem', { name: /SHA/ }).click()
    await expect(page.getByTestId('graph-header')).not.toContainText('SHA')
    await page.reload()
    await expect(page.getByTestId('graph-header')).toContainText('Branch / Tag')
    await expect(page.getByTestId('graph-header')).not.toContainText('SHA')
  } finally {
    await app.close()
  }
})

test('commit details: uncommitted-changes banner, tree view and all files', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'src/app/main.ts': '1\n', 'src/app/util.ts': '1\n', 'README.md': 'r\n' })
  repo.commit('touch two', { 'src/app/main.ts': '2\n', 'README.md': 'r2\n' })
  repo.write('wip.txt', 'w\n')
  const { app, page } = await launch({ repo: repo.dir, userData: makeTempDir('gitbob-ud-') })
  try {
    await page.locator('[data-testid="commit-row"]', { hasText: 'touch two' }).click()
    const panel = page.getByTestId('commit-details')
    await expect(panel.getByTestId('wip-banner')).toContainText('1 file change in the working directory')

    // Path view: folder dimmed, file name highlighted; Tree view: folders.
    await expect(panel.getByTestId('details-file')).toHaveCount(2)
    await panel.getByRole('button', { name: 'Tree' }).click()
    await expect(panel.locator('[data-testid="details-folder"][data-folder="src/app"]')).toBeVisible()
    await panel.locator('[data-testid="details-folder"][data-folder="src/app"]').click()
    await expect(panel.locator('[data-testid="details-file"][data-path="src/app/main.ts"]')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Path' }).click()

    // All files adds the unchanged one, marked as unchanged.
    await panel.getByLabel('All files').check()
    await expect(panel.getByTestId('details-file')).toHaveCount(3)
    await expect(panel.locator('[data-testid="details-file"][data-path="src/app/util.ts"]')).not.toHaveAttribute('data-changed', 'true')

    await panel.getByRole('button', { name: 'View changes' }).click()
    await expect(page.getByTestId('staging-panel')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('sidebar: hide a branch from the graph, filter branches, and collapsed sections dock at the bottom', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1\n' })
  repo.branch('experiment')
  repo.branch('feature/login')
  repo.checkout('experiment')
  repo.commit('try something', { 'x.txt': 'x\n' })
  repo.checkout('main')
  repo.commit('main work', { 'm.txt': 'm\n' })
  const userData = makeTempDir('gitbob-ud-')
  const { app, page } = await launch({ repo: repo.dir, userData })
  const item = (ref: string) => page.locator(`[data-testid="ref-item"][data-ref="${ref}"]`)
  try {
    await expect(page.getByTestId('viewing')).toContainText('Viewing 3/3')
    await expect(page.locator('[data-testid="commit-row"]', { hasText: 'try something' })).toBeVisible()

    await item('refs/heads/experiment').hover()
    await page.getByRole('button', { name: 'Hide experiment from the graph' }).click()
    await expect(page.locator('[data-testid="commit-row"]', { hasText: 'try something' })).toHaveCount(0)
    await expect(page.getByTestId('commit-row')).toHaveCount(2)
    await expect(item('refs/heads/experiment')).toHaveAttribute('data-hidden', 'true')
    await expect(page.getByTestId('viewing')).toContainText('Viewing 2/3')
    // The checked-out branch can't be hidden.
    await expect(page.getByRole('button', { name: 'Hide main from the graph' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Show all' }).click()
    await expect(page.locator('[data-testid="commit-row"]', { hasText: 'try something' })).toBeVisible()

    // Filter narrows the branch list.
    await page.getByLabel('Filter branches and tags').fill('log')
    await expect(page.locator('[data-testid="local-branches"] [data-testid="ref-item"]')).toHaveCount(1)
    await expect(item('refs/heads/feature/login')).toBeVisible()
    await page.getByLabel('Filter branches and tags').fill('')

    // A collapsed section sorts below the spacer (docked at the bottom).
    const tags = page.getByTestId('tags')
    await tags.locator('> div > button').click()
    await expect(tags).toHaveCSS('order', '2')
  } finally {
    await app.close()
  }
})

test('select several commits and see all their changes together', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  repo.commit('change a', { 'a.txt': 'a1\n' })
  repo.commit('change b', { 'b.txt': 'b1\n' })
  repo.commit('add c', { 'c.txt': 'c\n' })
  const { app, page } = await launch({ repo: repo.dir, userData: makeTempDir('gitbob-ud-') })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const row = (subject: string) => page.getByTestId('commit-row').filter({ hasText: subject })
  const files = () => page.getByTestId('multi-commit').getByTestId('details-file')
  try {
    // Scattered commits: only their own changes, not b.txt from the commit between them.
    await row('add c').click()
    await row('change a').click({ modifiers: [mod] })
    await expect(page.getByTestId('multi-commit-count')).toHaveText('2 commits selected')
    await expect(row('add c')).toHaveAttribute('aria-selected', 'true')
    await expect(row('change b')).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByTestId('multi-commit-mode')).toContainText('left out')
    await expect(files()).toHaveCount(2)
    await expect(page.locator('[data-testid="multi-commit"] [data-path="b.txt"]')).toHaveCount(0)

    // Opening a file shows the combined diff.
    await page.locator('[data-testid="multi-commit"] [data-path="a.txt"]').click()
    await expect(page.getByTestId('diff-path')).toContainText('a.txt')
    await expect(page.getByTestId('diff-table')).toContainText('a1')
    await expect(page.getByTestId('diff-view')).toContainText('Selected commits')
    await expect(page.getByTestId('diff-view').getByRole('button', { name: 'Blame' })).toHaveCount(0)

    // Shift-click: an unbroken range from the anchor.
    await page.getByTestId('diff-view').getByRole('button', { name: /close/i }).first().click()
    await row('add c').click()
    await row('change a').click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('multi-commit-count')).toHaveText('3 commits selected')
    await expect(page.getByTestId('multi-commit-mode')).toContainText('All changes')
    await expect(files()).toHaveCount(3)

    // ⌘/Ctrl-click takes one out again; a plain click goes back to one commit.
    await row('change b').click({ modifiers: [mod] })
    await expect(page.getByTestId('multi-commit-count')).toHaveText('2 commits selected')
    await row('base').click()
    await expect(page.getByTestId('multi-commit')).toHaveCount(0)
    await expect(page.getByTestId('commit-details')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('commits that only make sense with the ones between them offer the whole range', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': 'line\n' })
  repo.commit('middle', { 'a.txt': 'middle\n' })
  repo.commit('builds on middle', { 'a.txt': 'last\n' })
  const { app, page } = await launch({ repo: repo.dir, userData: makeTempDir('gitbob-ud-') })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await page.getByTestId('commit-row').filter({ hasText: 'builds on middle' }).click()
    await page.getByTestId('commit-row').filter({ hasText: 'base' }).click({ modifiers: [mod] })
    const error = page.getByTestId('multi-commit-error')
    await expect(error).toContainText("can't be combined")
    await expect(error).toContainText('a.txt')
    await error.getByRole('button', { name: 'Show the whole range instead' }).click()
    await expect(page.getByTestId('multi-commit-mode')).toContainText('including commits between them')
    await expect(page.getByTestId('multi-commit').getByTestId('details-file')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

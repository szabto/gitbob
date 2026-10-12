/* global document */
// Renders README / website screenshots of the real app against a generated demo repository.
// Usage: npm run build && node scripts/screenshots.mjs
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildConflictRepo, buildDemoRepo } from './demo-repo.mjs'

const appDir = resolve(import.meta.dirname, '..')
const outDir = join(appDir, 'docs/images')
mkdirSync(outDir, { recursive: true })

const demo = buildDemoRepo()

// GitHub stand-in for the pull request and clone screenshots: origin keeps fetching from the local
// bare repository; its push URL tells GitBob which GitHub repository this is.
const TOKEN = 'github_pat_screenshot'
const gitDemo = (...args) => execFileSync('git', args, { cwd: demo.dir, env: { ...process.env, HOME: demo.home, GIT_CONFIG_GLOBAL: join(demo.home, '.gitconfig') } })
gitDemo('push', '-q', 'origin', 'fix/chart-overflow:refs/pull/7/head')
gitDemo('remote', 'set-url', '--push', 'origin', 'https://github.com/aurora-weather/aurora.git')
const prHead = gitDemo('rev-parse', 'fix/chart-overflow').toString().trim()
const prBase = gitDemo('rev-parse', 'origin/main').toString().trim()
const fake = await new Promise((resolveServer) => {
  const pull = {
    id: 9007, number: 7, title: 'Clamp chart bars to the viewport', state: 'open', draft: false, merged_at: null,
    body: 'Tall temperatures pushed bars outside the chart on small screens. Bars are now clamped to the viewport height.\n\nFixes #31.',
    user: { login: 'lena-k' }, head: { ref: 'fix/chart-overflow', sha: prHead, repo: { id: 1 } }, base: { ref: 'main', sha: prBase, repo: { id: 1 } },
    html_url: 'https://github.com/aurora-weather/aurora/pull/7', created_at: '2026-10-08T09:12:00Z', updated_at: '2026-10-10T16:40:00Z',
    mergeable: true, mergeable_state: 'clean', additions: 3, deletions: 0, changed_files: 1, requested_reviewers: [{ login: 'sam-ortiz' }], requested_teams: [],
  }
  const repos = [
    ['aurora-weather/aurora', 'A calm, fast weather app', true, '2026-10-10T16:40:00Z'],
    ['aurora-weather/aurora-api', 'Forecast API and caching proxy', true, '2026-10-09T11:00:00Z'],
    ['aurora-weather/design-system', 'Colors, type and icons for Aurora', false, '2026-10-02T08:00:00Z'],
    ['maya-chen/dotfiles', null, false, '2026-09-28T19:30:00Z'],
    ['maya-chen/advent-of-code', 'Solutions, mostly in TypeScript', false, '2026-09-12T07:00:00Z'],
  ].map(([full_name, description, priv, pushed_at]) => ({ full_name, description, private: priv, pushed_at, clone_url: `https://github.com/${full_name}.git`, ssh_url: `git@github.com:${full_name}.git` }))
  const server = createServer((req, res) => {
    const json = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json({ message: 'Bad credentials' }, 401)
    const p = new URL(req.url, 'http://x').pathname
    const R = '/repos/aurora-weather/aurora'
    if (p === '/user') return json({ login: 'maya-chen', name: 'Maya Chen' })
    if (p === '/user/repos') return json(repos)
    if (p === R) return json({ allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true, permissions: { push: true } })
    if (p === `${R}/pulls`) return json([pull])
    if (p === `${R}/pulls/7`) return json(pull)
    if (p === `${R}/pulls/7/reviews`) return json([{ id: 1, user: { login: 'kenji-w' }, state: 'APPROVED', body: '', submitted_at: '2026-10-10T10:00:00Z' }])
    if (p === `${R}/issues/7/comments`)
      return json([
        { id: 11, user: { login: 'kenji-w' }, body: 'Checked on a 320px wide screen, looks right now. 👍', created_at: '2026-10-10T10:02:00Z' },
        { id: 12, user: { login: 'lena-k' }, body: 'Thanks! I also tried negative temperatures, they stay at the baseline.', created_at: '2026-10-10T12:30:00Z' },
      ])
    if (p === `${R}/pulls/7/comments`)
      return json([{ id: 21, user: { login: 'sam-ortiz' }, body: 'Could we keep a 1px minimum so zero degrees is still visible?', created_at: '2026-10-10T14:00:00Z', path: 'src/components/HourlyChart.tsx', line: 3, side: 'RIGHT' }])
    if (p.endsWith('/status')) return json({ state: 'success', statuses: [{ state: 'success', context: 'ci/build', target_url: 'https://ci.example/1' }] })
    if (p.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success', name: 'test', html_url: 'https://ci.example/2' }] })
    json({ message: 'Not Found' }, 404)
  })
  server.listen(0, '127.0.0.1', () => resolveServer({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }))
})
const userData = mkdtempSync(join(tmpdir(), 'gitbob-shot-ud-'))
// README/site screenshots use the dark theme regardless of the OS appearance.
// Initials instead of avatars: deterministic pictures and no requests to GitHub while shooting.
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme: 'dark', avatars: 'off' }))

async function launch(args, home = demo.home) {
  const app = await electron.launch({
    args: [appDir, ...args],
    env: {
      ...process.env,
      GITBOB_USER_DATA: userData,
      ELECTRON_RENDERER_URL: '',
      GITBOB_HIDDEN: '1',
      GITBOB_EPHEMERAL_TOKENS: '1',
      GITBOB_TEST_PROVIDER_API_GITHUB: fake.url,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    },
  })
  const page = await app.firstWindow()
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {}
  })
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1440, 900)
    w.center()
  })
  await page.waitForTimeout(300)
  return { app, page }
}

const shot = async (page, name) => {
  // Keep hover-only controls (line comment +, row highlights) out of the picture.
  await page.mouse.move(2, 890)
  await page.waitForTimeout(350)
  if (process.env.DEBUG_SHOTS) {
    console.log(name, await page.evaluate(() => ({
      sel: document.querySelector('[aria-selected="true"]')?.textContent?.slice(0, 40) ?? null,
      staging: !!document.querySelector('[data-testid="staging-panel"]'),
      diff: !!document.querySelector('[data-testid="diff-view"]'),
    })))
  }
  await page.screenshot({ path: join(outDir, `${name}.png`) })
  console.log('wrote', name)
}

try {
  let { app, page } = await launch([demo.dir])
  await page.getByTestId('commit-row').first().waitFor()

  // Hero: graph with a merge commit selected.
  await page.locator('[data-testid="commit-row"]', { hasText: 'Merge branch feature/city-search' }).click()
  await page.getByTestId('details-subject').waitFor()
  await shot(page, 'gitbob-graph')

  // Commit diff.
  await page.locator('[data-testid="commit-row"]', { hasText: 'Retry forecast requests with backoff' }).click()
  await page.locator('[data-testid="details-file"]').first().click()
  await page.getByTestId('diff-table').waitFor()
  await shot(page, 'gitbob-commit-diff')

  // Working changes + diff.
  await page.locator('[data-testid="diff-view"] button', { hasText: 'Close' }).click()
  await page.getByTestId('wip-row').click()
  await page.getByTestId('staging-panel').waitFor()
  await page.locator('[data-testid="unstaged-files"] [data-path="src/App.tsx"]').click()
  await page.getByTestId('diff-table').waitFor()
  // Side-by-side variant of the same diff.
  await page.getByRole('button', { name: 'Side by side' }).click()
  await page.getByTestId('side-by-side-diff').locator('.monaco-diff-editor').waitFor()
  await page.waitForTimeout(800)
  await shot(page, 'gitbob-side-by-side')
  await page.getByRole('button', { name: 'Unified' }).click()
  await page.getByTestId('diff-table').waitFor()

  await page.getByLabel('Commit summary').fill('Compose the dashboard layout')
  await page.getByLabel('Commit description').fill('Wire the city search and hourly chart into the main view.')
  await shot(page, 'gitbob-staging')

  // Branch context menu.
  await page.locator('[data-testid="diff-view"] button', { hasText: 'Close' }).click()
  await page.locator('[data-testid="ref-item"][data-ref="refs/heads/feature/offline-mode"]').click()
  await page.getByTestId('commit-details').waitFor()
  await page.locator('[data-testid="ref-item"][data-ref="refs/heads/feature/offline-mode"]').click({ button: 'right' })
  await page.getByTestId('context-menu').waitFor()
  await shot(page, 'gitbob-branches')
  await page.keyboard.press('Escape')

  // Commit history menu (cherry-pick, revert, reset).
  await page.locator('[data-testid="commit-row"]', { hasText: 'Clamp chart bars' }).click({ button: 'right' })
  await page.getByTestId('context-menu').waitFor()
  await shot(page, 'gitbob-history-menu')
  await page.keyboard.press('Escape')

  // Interactive rebase dialog.
  await page.locator('[data-testid="commit-row"]', { hasText: 'Release 0.2.0' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Interactive rebase commits after/ }).click()
  await page.getByTestId('rebase-row').first().waitFor()
  await page.getByLabel('Action for Document the forecast API').selectOption('reword')
  await page.getByLabel('New message for Document the forecast API').fill('Document getForecast() and the retry helper')
  await page.getByLabel('Action for Polish search empty state').selectOption('squash')
  await shot(page, 'gitbob-rebase')
  await page.getByTestId('rebase-dialog').getByRole('button', { name: 'Cancel' }).click()

  // Blame.
  await page.locator('[data-testid="commit-row"]', { hasText: 'Retry forecast requests with backoff' }).click()
  await page.locator('[data-testid="details-file"]').first().click()
  await page.getByRole('button', { name: 'Blame' }).click()
  await page.getByTestId('blame-line').first().waitFor()
  await shot(page, 'gitbob-blame')
  await page.getByTestId('blame-view').getByRole('button', { name: 'Close' }).click()

  // File history.
  await page.locator('[data-testid="commit-row"]', { hasText: 'Retry forecast requests with backoff' }).click()
  await page.locator('[data-testid="details-file"]').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'File history' }).click()
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.getByTestId('file-history-entry').nth(1).click()
  await page.getByTestId('file-history').getByTestId('diff-table').waitFor()
  await shot(page, 'gitbob-file-history')
  await page.getByTestId('file-history').getByRole('button', { name: 'Close' }).first().click()

  // Drag a branch onto the current one.
  await page.locator('[data-testid="ref-item"][data-ref="refs/heads/fix/chart-overflow"]').dragTo(page.locator('[data-testid="ref-item"][data-ref="refs/heads/main"]'))
  await page.getByTestId('context-menu').waitFor()
  await shot(page, 'gitbob-drag-merge')
  await page.keyboard.press('Escape')

  // Hosting: connect GitHub, open a pull request, its files with a line comment.
  await page.getByRole('button', { name: 'Close details' }).click().catch(() => {})
  const prs = page.getByTestId('pull-requests')
  await prs.getByTestId('connect-provider').click()
  await page.getByLabel(/Personal access token/).fill(TOKEN)
  await page.getByTestId('prompt-dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await prs.getByTestId('pull-request').click()
  await page.getByTestId('pr-comments').waitFor()
  await page.getByTestId('pr-ci').waitFor()
  await page.getByRole('button', { name: 'Dismiss notice' }).click().catch(() => {})
  await shot(page, 'gitbob-pr')
  await page.getByTestId('pr-view').getByRole('tab', { name: 'Files' }).click()
  await page.getByTestId('pr-file').first().click()
  await page.locator('[data-testid="line-comments"]').first().waitFor()
  await shot(page, 'gitbob-pr-files')
  await page.getByTestId('diff-view').getByRole('button', { name: 'Close' }).click()
  await page.getByTestId('pr-view').getByRole('button', { name: 'Close', exact: true }).click()

  // Clone from your repositories.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:clone-repository'))
  await page.getByTestId('clone-repo').first().waitFor()
  await page.getByLabel('Repository URL').fill('aurora')
  await shot(page, 'gitbob-clone')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByTestId('clone-dialog').waitFor({ state: 'detached' })

  // Whole-history search.
  await page.getByLabel('Search history').fill('forecast')
  await page.getByTestId('search-count').filter({ hasText: 'of' }).waitFor()
  await page.getByLabel('Search history').press('Enter')
  await page.getByTestId('details-subject').waitFor()
  await shot(page, 'gitbob-search')
  await page.getByLabel('Search history').press('Escape')

  // Graph filter by author.
  await page.getByTestId('filter-button').click()
  await page.getByLabel('Author', { exact: true }).fill('Kenji')
  await shot(page, 'gitbob-filter-form')
  await page.getByRole('button', { name: 'Apply filter' }).click()
  await page.getByTestId('filter-summary').waitFor()
  await shot(page, 'gitbob-filter')
  await page.getByRole('button', { name: 'Clear filter' }).first().click()

  // Stash panel.
  await page.locator('[data-testid="stashes"] > div > button').click()
  await page.getByTestId('stash-item').first().click()
  await page.getByTestId('stash-panel').waitFor()
  await shot(page, 'gitbob-stash')

  // Command palette.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command-palette'))
  await page.getByLabel('Type a command').fill('pu')
  await page.getByTestId('palette-item').first().waitFor()
  await shot(page, 'gitbob-palette')
  await page.keyboard.press('Escape')

  // Light theme.
  await app.evaluate(({ nativeTheme, BrowserWindow }) => {
    nativeTheme.themeSource = 'light'
    BrowserWindow.getAllWindows()[0].webContents.send('theme:changed', { theme: 'light' })
  })
  await page.locator('[data-testid="commit-row"]', { hasText: 'Merge branch feature/city-search' }).click()
  await page.getByTestId('details-subject').waitFor()
  await shot(page, 'gitbob-light')
  await app.evaluate(({ nativeTheme, BrowserWindow }) => {
    nativeTheme.themeSource = 'dark'
    BrowserWindow.getAllWindows()[0].webContents.send('theme:changed', { theme: 'dark' })
  })

  await app.close()

  // Conflict editor on a repository stopped in a merge.
  const conflict = buildConflictRepo()
  try {
    ;({ app, page } = await launch([conflict.dir], conflict.home))
    await page.getByTestId('wip-row').click()
    await page.locator('[data-testid="conflicted-files"] [data-path="settings.ts"]').click()
    await page.getByTestId('conflict-result').locator('.monaco-editor').waitFor()
    await page.waitForTimeout(1000)
    await shot(page, 'gitbob-conflict')
    await app.close()
  } finally {
    conflict.cleanup()
  }

  // Welcome screen (in a new tab) with the repository in recents.
  ;({ app, page } = await launch([]))
  await page.getByRole('button', { name: 'New tab' }).click()
  await page.getByText('Recent repositories').waitFor()
  await shot(page, 'gitbob-welcome')
  await app.close()
} finally {
  fake.close()
  demo.cleanup()
}

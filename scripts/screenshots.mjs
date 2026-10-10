/* global document */
// Renders README / website screenshots of the real app against a generated demo repository.
// Usage: npm run build && node scripts/screenshots.mjs
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildConflictRepo, buildDemoRepo } from './demo-repo.mjs'

const appDir = resolve(import.meta.dirname, '..')
const outDir = join(appDir, 'docs/images')
mkdirSync(outDir, { recursive: true })

const demo = buildDemoRepo()
const userData = mkdtempSync(join(tmpdir(), 'gitbob-shot-ud-'))
// README/site screenshots use the dark theme regardless of the OS appearance.
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme: 'dark' }))

async function launch(args) {
  const app = await electron.launch({
    args: [appDir, ...args],
    env: {
      ...process.env,
      GITBOB_USER_DATA: userData,
      ELECTRON_RENDERER_URL: '',
      GITBOB_HIDDEN: '1',
      HOME: demo.home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(demo.home, '.gitconfig'),
    },
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1440, 900)
    w.center()
  })
  await page.waitForTimeout(300)
  return { app, page }
}

const shot = async (page, name) => {
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
  await page.getByRole('menuitem', { name: /Interactive rebase/ }).click()
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

  // Whole-history search.
  await page.getByLabel('Search history').fill('forecast')
  await page.getByTestId('search-count').filter({ hasText: 'of' }).waitFor()
  await page.getByLabel('Search history').press('Enter')
  await page.getByTestId('details-subject').waitFor()
  await shot(page, 'gitbob-search')
  await page.getByLabel('Search history').press('Escape')

  // Graph filter by author.
  await page.getByTestId('filter-button').click()
  await page.getByLabel('Author').fill('Kenji')
  await shot(page, 'gitbob-filter-form')
  await page.getByRole('button', { name: 'Apply filter' }).click()
  await page.getByTestId('filter-summary').waitFor()
  await shot(page, 'gitbob-filter')
  await page.getByRole('button', { name: 'Clear filter' }).first().click()

  // Stash panel.
  await page.getByTestId('stash-item').first().click()
  await page.getByTestId('stash-panel').waitFor()
  await shot(page, 'gitbob-stash')

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
    ;({ app, page } = await launch([conflict.dir]))
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
  demo.cleanup()
}

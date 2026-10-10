/* global document */
// Renders README / website screenshots of the real app against a generated demo repository.
// Usage: npm run build && node scripts/screenshots.mjs
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildDemoRepo } from './demo-repo.mjs'

const appDir = resolve(import.meta.dirname, '..')
const outDir = join(appDir, 'docs/images')
mkdirSync(outDir, { recursive: true })

const demo = buildDemoRepo()
const userData = mkdtempSync(join(tmpdir(), 'gitbob-shot-ud-'))

async function launch(args) {
  const app = await electron.launch({
    args: [appDir, ...args],
    env: {
      ...process.env,
      GITBOB_USER_DATA: userData,
      ELECTRON_RENDERER_URL: '',
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

  await app.close()

  // Welcome screen with the repository in recents.
  ;({ app, page } = await launch([]))
  await page.getByText('Recent repositories').waitFor()
  await shot(page, 'gitbob-welcome')
  await app.close()
} finally {
  demo.cleanup()
}

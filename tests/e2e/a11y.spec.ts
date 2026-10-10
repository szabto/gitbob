import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

interface AxeViolation {
  id: string
  impact: string | null
  help: string
  nodes: { target: string[] }[]
}

async function audit(page: Page, label: string) {
  // Injected through the debugger protocol, so the app's CSP does not block it.
  await page.evaluate(axeSource)
  const results = await page.evaluate(async () => {
    const axe = (globalThis as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe
    // Monaco renders its own editor DOM; it is audited by its maintainers.
    return axe.run(
      { exclude: [['.monaco-editor']] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } },
    )
  })
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const report = serious.map((v) => `${label}: [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length}x) e.g. ${v.nodes[0]?.target.join(' ')}`)
  return report
}

test.afterAll(cleanupFixtures)

for (const theme of ['dark', 'light'] as const) {
  test(`no serious accessibility violations on the main screens (${theme})`, async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n' })
    repo.branch('feature')
    repo.commit('second', { 'a.txt': '2\n' })
    repo.write('a.txt', '3\n')
    const userData = makeTempDir('gitbob-ud-')
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme }))
    const app = await electron.launch({
      args: [appDir, repo.dir],
      env: {
        ...process.env,
        GITBOB_USER_DATA: userData,
        ELECTRON_RENDERER_URL: '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(makeTempDir('gitbob-home-'), '.gitconfig'),
      },
    })
    const page = await app.firstWindow()
    try {
      const problems: string[] = []
      await page.getByTestId('commit-row').first().waitFor()
      await page.getByTestId('commit-row').first().click()
      await page.getByTestId('details-subject').waitFor()
      problems.push(...(await audit(page, 'graph')))

      await page.getByTestId('wip-row').click()
      await page.locator('[data-testid="unstaged-files"] [data-path="a.txt"]').click()
      await page.getByTestId('diff-table').waitFor()
      problems.push(...(await audit(page, 'staging')))

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:settings'))
      await page.getByTestId('settings-dialog').waitFor()
      problems.push(...(await audit(page, 'settings')))
      await page.keyboard.press('Escape')

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:command-palette'))
      await page.getByTestId('command-palette').waitFor()
      problems.push(...(await audit(page, 'palette')))
      await page.keyboard.press('Escape')

      await page.getByRole('button', { name: 'New tab' }).click()
      await page.getByRole('heading', { name: 'Recent repositories' }).waitFor()
      problems.push(...(await audit(page, 'welcome')))

      expect(problems, problems.join('\n')).toEqual([])
    } finally {
      await app.close()
    }
  })
}

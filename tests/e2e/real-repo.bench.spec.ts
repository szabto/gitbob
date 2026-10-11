/**
 * App-level benchmark on a real repository (hidden window, like every E2E run):
 *
 *   GITBOB_BENCH_REPO=/path/to/clone npx playwright test tests/e2e/real-repo.bench.spec.ts
 *
 * Measures time to the first graph rows, scrolling through the whole history (all pages),
 * frame times while scrolling, and memory. The repository is only read.
 */
import { test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { makeTempDir } from '../helpers/fixture'

const REPO = process.env.GITBOB_BENCH_REPO ?? ''
const appDir = resolve(import.meta.dirname, '../..')

test('real repository: open, scroll the whole history, memory', async () => {
  test.skip(!REPO, 'set GITBOB_BENCH_REPO to run')
  test.setTimeout(900_000)
  const total = Number(execFileSync('git', ['rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim())
  const t0 = Date.now()
  const app = await electron.launch({
    args: [appDir, REPO],
    env: { ...process.env, GITBOB_USER_DATA: makeTempDir('gitbob-ud-'), ELECTRON_RENDERER_URL: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(makeTempDir('gitbob-home-'), '.gitconfig') },
  })
  const results: Record<string, number | string> = { repo: REPO, commits: total }
  try {
    const page = await app.firstWindow()
    await page.getByTestId('commit-row').first().waitFor({ timeout: 120_000 })
    results['launch → first rows (ms)'] = Date.now() - t0

    // Frame times while scrolling through the loaded rows in big steps.
    const frames = await page.evaluate(async () => {
      const el = document.querySelector('[data-testid="commit-graph"]') as HTMLElement
      const times: number[] = []
      let last = performance.now()
      for (let i = 0; i < 120; i++) {
        el.scrollTop += 600
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const now = performance.now()
        times.push(now - last)
        last = now
      }
      times.sort((a, b) => a - b)
      return { p50: Math.round(times[60]!), p95: Math.round(times[114]!), max: Math.round(times[119]!) }
    })
    results['scroll frame p50/p95/max (ms)'] = `${frames.p50} / ${frames.p95} / ${frames.max}`

    // Jump to the end repeatedly until every page is loaded.
    const t1 = Date.now()
    const count = page.getByTestId('commit-count')
    for (;;) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="commit-graph"]') as HTMLElement
        el.scrollTop = el.scrollHeight
      })
      const text = (await count.textContent()) ?? ''
      if (Number(text.replace(/\D/g, '')) >= total && !/\+/.test(text)) break
      if (Date.now() - t1 > 600_000) throw new Error(`still loading: ${text}`)
      await page.waitForTimeout(100)
    }
    results['scroll to the end, all pages (ms)'] = Date.now() - t1

    const endFrames = await page.evaluate(async () => {
      const el = document.querySelector('[data-testid="commit-graph"]') as HTMLElement
      const times: number[] = []
      let last = performance.now()
      for (let i = 0; i < 60; i++) {
        el.scrollTop -= 900
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const now = performance.now()
        times.push(now - last)
        last = now
      }
      times.sort((a, b) => a - b)
      return { p50: Math.round(times[30]!), p95: Math.round(times[57]!), max: Math.round(times[59]!) }
    })
    results['scroll frame with everything loaded p50/p95/max (ms)'] = `${endFrames.p50} / ${endFrames.p95} / ${endFrames.max}`

    const t2 = Date.now()
    await page.getByTestId('commit-row').first().click()
    await page.getByTestId('details-subject').waitFor()
    results['click a commit → details (ms)'] = Date.now() - t2

    const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)
    results['renderer JS heap (MB)'] = Math.round(heap / 1e6)
    const mainMem = await app.evaluate(() => process.memoryUsage().rss)
    results['main process RSS (MB)'] = Math.round(mainMem / 1e6)
    console.log(JSON.stringify(results, null, 2))
  } finally {
    await app.close()
  }
})

import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

/**
 * Smoke test for the packaged app (run `npm run dist:dir` first). Skipped when
 * no packaged build exists for this platform.
 */
const root = resolve(import.meta.dirname, '../..')
const version = (await import(join(root, 'package.json'), { with: { type: 'json' } })).default.version as string
const candidates = [
  join(root, `release/${version}/mac-arm64/GitBob.app/Contents/MacOS/GitBob`),
  join(root, `release/${version}/mac/GitBob.app/Contents/MacOS/GitBob`),
  join(root, `release/${version}/linux-unpacked/gitbob`),
  join(root, `release/${version}/win-unpacked/GitBob.exe`),
]
const executable = candidates.find((p) => existsSync(p))

test.afterAll(cleanupFixtures)

test('packaged app opens a repository and renders history', async () => {
  test.skip(!executable, 'no packaged build found; run npm run dist:dir')
  const repo = createFixtureRepo()
  repo.commit('first', { 'a.txt': '1' })
  repo.commit('second', { 'a.txt': '2' })
  const app = await electron.launch({
    executablePath: executable!,
    args: [repo.dir],
    env: { ...process.env, GITBOB_USER_DATA: makeTempDir('gitbob-ud-') },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('commit-row')).toHaveCount(2)
    await expect(page.getByTestId('commit-row').first().getByTestId('commit-subject')).toHaveText('second')
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
  } finally {
    await app.close()
  }
})

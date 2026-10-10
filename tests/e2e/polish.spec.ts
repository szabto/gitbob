import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

const appDir = resolve(import.meta.dirname, '../..')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function launch(repo: string, userData = makeTempDir('gitbob-ud-'), extraEnv: Record<string, string> = {}) {
  const app = await electron.launch({
    args: [appDir, repo],
    env: {
      ...process.env,
      GITBOB_USER_DATA: userData,
      ELECTRON_RENDERER_URL: '',
      GIT_AUTHOR_NAME: 'E2E Author',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E Author',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(makeTempDir('gitbob-home-'), '.gitconfig'),
      ...extraEnv,
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

const openPalette = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:command-palette'))
const openSettings = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:settings'))

test.afterAll(cleanupFixtures)

test('command palette runs commands and checks out branches', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1' })
  repo.branch('feature/palette')
  const { app, page } = await launch(repo.dir)
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(1)
    await openPalette(app)
    const palette = page.getByTestId('command-palette')
    await palette.getByLabel('Type a command').fill('check feature')
    await expect(palette.getByTestId('palette-item').first()).toContainText('Check out feature/palette')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await expect(page.getByTestId('head-label')).toHaveText('feature/palette')

    // Built-in command with fuzzy matching.
    await openPalette(app)
    await page.getByLabel('Type a command').fill('crt brnch')
    await expect(page.getByTestId('palette-item').first()).toContainText('Create branch')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('prompt-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
})

test('rebinding a shortcut in Settings works and persists', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1' })
  const userData = makeTempDir('gitbob-ud-')
  let { app, page } = await launch(repo.dir, userData)
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(1)
    // Default: Mod+B opens "Create branch".
    await page.getByTestId('commit-graph').focus()
    await page.keyboard.press(`${mod}+B`)
    await expect(page.getByTestId('prompt-dialog')).toContainText('Create branch')
    await page.keyboard.press('Escape')

    await openSettings(app)
    const dialog = page.getByTestId('settings-dialog')
    await dialog.getByRole('button', { name: 'Keyboard shortcuts' }).click()
    const btn = dialog.getByTestId('shortcut-branch.create')
    await btn.click()
    await page.keyboard.press('B') // no modifier: refused
    await expect(dialog.getByRole('alert')).toContainText('at least one of')
    await btn.click()
    await page.keyboard.press(`${mod}+Alt+N`) // reserved by the menu
    await expect(dialog.getByRole('alert')).toContainText('used by the menu')
    await btn.click()
    await page.keyboard.press(`${mod}+Shift+B`)
    await expect(btn).not.toHaveText('Press keys…')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0)

    await page.getByTestId('commit-graph').focus()
    await page.keyboard.press(`${mod}+Shift+B`)
    await expect(page.getByTestId('prompt-dialog')).toContainText('Create branch')
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
  ;({ app, page } = await launch(repo.dir, userData))
  try {
    await expect(page.getByTestId('commit-row')).toHaveCount(1)
    await page.getByTestId('commit-graph').focus()
    await page.keyboard.press(`${mod}+Shift+B`)
    await expect(page.getByTestId('prompt-dialog')).toContainText('Create branch')
  } finally {
    await app.close()
  }
})

test('settings: theme, git program validation and version info', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1' })
  const notGit = join(makeTempDir('gitbob-notgit-'), 'git')
  writeFileSync(notGit, '#!/bin/sh\necho "hello"\n', { mode: 0o755 })
  const { app, page } = await launch(repo.dir)
  try {
    await openSettings(app)
    const dialog = page.getByTestId('settings-dialog')
    await dialog.getByLabel('Theme').selectOption('light')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')

    await dialog.getByRole('button', { name: 'Git', exact: true }).click()
    await expect(dialog.getByTestId('git-path')).toContainText('version')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, notGit)
    await dialog.getByRole('button', { name: 'Choose…' }).click()
    await expect(page.getByTestId('error-message')).toContainText('is not a working Git executable')
    await expect(dialog.getByTestId('git-path')).not.toContainText(notGit)

    await dialog.getByRole('button', { name: 'About & updates' }).click()
    await expect(dialog.getByTestId('app-version')).toContainText('GitBob 0.')
  } finally {
    await app.close()
  }
})

test('shows repository paths under the home folder as ~/…', async () => {
  // Point the app's HOME at the fixture's parent so the path is "under home".
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1' })
  const parent = resolve(repo.dir, '..')
  const { app, page } = await launch(repo.dir, makeTempDir('gitbob-ud-'), { HOME: parent })
  try {
    await expect(page.getByTestId('repo-path')).toHaveText(`~/${repo.dir.split('/').pop()}`)
    expect(homedir()).not.toBe(parent)
  } finally {
    await app.close()
  }
})

test('first run: shows the Git version and sets a missing identity (isolated config)', async () => {
  const home = makeTempDir('gitbob-home-')
  const globalConfig = join(home, '.gitconfig')
  writeFileSync(globalConfig, '')
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      GITBOB_USER_DATA: makeTempDir('gitbob-ud-'),
      ELECTRON_RENDERER_URL: '',
      GIT_CONFIG_NOSYSTEM: '1',
      // Never touch the developer's real ~/.gitconfig.
      GIT_CONFIG_GLOBAL: globalConfig,
    },
  })
  const page = await app.firstWindow()
  try {
    await expect(page.getByTestId('git-ok')).toContainText('Using Git')
    const form = page.getByTestId('identity-form')
    await form.getByPlaceholder('Your name').fill('Ada Lovelace')
    await form.getByPlaceholder('you@example.com').fill('ada@example.com')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('identity-form')).toHaveCount(0)
    await expect(page.getByTestId('git-ok')).toContainText('Ada Lovelace <ada@example.com>')
    const written = (await import('node:fs')).readFileSync(globalConfig, 'utf8')
    expect(written).toContain('name = Ada Lovelace')
    expect(written).toContain('email = ada@example.com')

    await page.getByTestId('tips').getByRole('button', { name: 'Hide tips' }).click()
    await expect(page.getByTestId('tips')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

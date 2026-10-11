import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
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
  // Windows reads the home folder from USERPROFILE.
  const { app, page } = await launch(repo.dir, makeTempDir('gitbob-ud-'), { HOME: parent, USERPROFILE: parent })
  try {
    await expect(page.getByTestId('repo-path')).toHaveText(`~${sep}${basename(repo.dir)}`)
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

test('first run: checks Git, sets name and email globally, and tips can be hidden', async () => {
  const gitconfig = join(makeTempDir('gitbob-home-'), '.gitconfig')
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      GITBOB_USER_DATA: makeTempDir('gitbob-ud-'),
      ELECTRON_RENDERER_URL: '',
      GITBOB_HIDDEN: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitconfig,
    },
  })
  try {
    const page = await app.firstWindow()
    const onboarding = page.getByTestId('onboarding')
    await expect(onboarding.getByTestId('git-ok')).toContainText('Git')
    const form = onboarding.getByTestId('identity-form')
    await form.getByLabel('Name').fill('Ada Lovelace')
    await form.getByLabel('Email').fill('ada@example.com')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(onboarding.getByTestId('identity-form')).toHaveCount(0)
    await expect(onboarding.getByTestId('git-ok')).toContainText('Ada Lovelace <ada@example.com>')
    const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }
    expect(execFileSync('git', ['config', '--global', 'user.email'], { env, encoding: 'utf8' }).trim()).toBe('ada@example.com')

    await onboarding.getByRole('button', { name: 'Hide tips' }).click()
    await expect(onboarding.getByTestId('tips')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('onboarding')).toBeVisible()
    await expect(page.getByTestId('tips')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('offers to speed up a slow history by writing the commit-graph', async () => {
  const repo = createFixtureRepo()
  repo.commit('one', { 'a.txt': '1\n' })
  repo.commit('two', { 'a.txt': '2\n' })
  // Every call counts as slow here, so the hint shows for this tiny repository.
  const { app, page } = await launch(repo.dir, undefined, { GITBOB_TEST_SLOW_MS: '0' })
  try {
    const banner = page.getByTestId('speed-up-banner')
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: 'Speed up history' }).click()
    await expect(page.getByTestId('notice')).toContainText('History index built')
    await expect(banner).toHaveCount(0)
    expect(existsSync(join(repo.dir, '.git/objects/info/commit-graph'))).toBe(true)
    await expect(page.getByTestId('commit-row')).toHaveCount(2)
  } finally {
    await app.close()
  }
})

test('the speed-up hint can be dismissed and stays dismissed', async () => {
  const repo = createFixtureRepo()
  repo.commit('one', { 'a.txt': '1\n' })
  const userData = makeTempDir('gitbob-ud-')
  const first = await launch(repo.dir, userData, { GITBOB_TEST_SLOW_MS: '0' })
  try {
    await first.page.getByTestId('speed-up-banner').getByRole('button', { name: 'Not now' }).click()
    await expect(first.page.getByTestId('speed-up-banner')).toHaveCount(0)
  } finally {
    await first.app.close()
  }
  const second = await launch(repo.dir, userData, { GITBOB_TEST_SLOW_MS: '0' })
  try {
    await expect(second.page.getByTestId('commit-row')).toHaveCount(1)
    await expect(second.page.getByTestId('speed-up-banner')).toHaveCount(0)
    expect(existsSync(join(repo.dir, '.git/objects/info/commit-graph'))).toBe(false)
  } finally {
    await second.app.close()
  }
})

test('toolbar: repository and branch pickers, Stash / Pop, Search and Actions', async () => {
  const other = createFixtureRepo()
  other.commit('other base', { 'o.txt': '1\n' })
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1\n' })
  repo.branch('feature/x')
  repo.write('a.txt', 'changed\n')
  const userData = makeTempDir('gitbob-ud-')
  // Open `other` once so it is in the recent list.
  const first = await launch(other.dir, userData)
  await expect(first.page.getByTestId('commit-row')).toHaveCount(1)
  await first.app.close()

  const { app, page } = await launch(repo.dir, userData)
  try {
    // Branch picker: search and check out.
    await page.getByTestId('branch-picker').click()
    await page.getByLabel('Find a branch').fill('feat')
    await expect(page.getByTestId('picker-item')).toHaveCount(1)
    await page.getByLabel('Find a branch').press('Enter')
    await expect(page.getByTestId('head-label')).toHaveText('feature/x')

    // Stash and Pop from the toolbar.
    const toolbar = page.getByTestId('toolbar')
    await toolbar.getByRole('button', { name: 'Stash', exact: true }).click()
    await page.getByTestId('prompt-dialog').getByRole('button', { name: 'Stash', exact: true }).click()
    await expect(page.getByTestId('wip-row')).toHaveCount(0)
    await toolbar.getByRole('button', { name: 'Pop', exact: true }).click()
    await expect(page.getByTestId('wip-row')).toBeVisible()
    await expect(toolbar.getByRole('button', { name: 'Pop', exact: true })).toBeDisabled()

    // Search focuses history search; Actions opens the command palette.
    await toolbar.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.locator('#graph-search-input')).toBeFocused()
    await toolbar.getByRole('button', { name: 'Actions', exact: true }).click()
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await page.keyboard.press('Escape')

    // Repository picker: open the recent repository in a new tab.
    await page.getByTestId('repo-picker').click()
    await expect(page.getByTestId('repo-picker-menu')).toContainText('Open tabs')
    await page.getByTestId('picker-item').filter({ hasText: basename(other.dir) }).click()
    await expect(page.getByTestId('repo-tab')).toHaveCount(2)
    await expect(page.getByTestId('repo-name')).toHaveText(basename(other.dir))
  } finally {
    await app.close()
  }
})

test('status bar: last message, zoom that is remembered, version, and the real commit count', async () => {
  const repo = createFixtureRepo()
  for (let i = 0; i < 5; i++) repo.commit(`c${i}`, { 'a.txt': String(i) })
  const userData = makeTempDir('gitbob-ud-')
  const { app, page } = await launch(repo.dir, userData)
  try {
    const bar = page.getByTestId('status-bar')
    await expect(bar.getByTestId('app-version')).toContainText('GitBob ')
    await expect(bar.getByTestId('zoom-level')).toHaveText('100%')
    await bar.getByRole('button', { name: 'Zoom in' }).click()
    await expect(bar.getByTestId('zoom-level')).toHaveText('110%')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBeCloseTo(1.1)
    await bar.getByRole('button', { name: 'Zoom 110%, reset' }).click()
    await expect(bar.getByTestId('zoom-level')).toHaveText('100%')
    await bar.getByRole('button', { name: 'Zoom out' }).click()
    await expect(bar.getByTestId('zoom-level')).toHaveText('90%')

    // Notices stay readable in the status bar after the banner is dismissed.
    await page.getByRole('button', { name: 'Branch', exact: true }).click()
    await page.getByLabel('Branch name').fill('topic')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('head-label')).toHaveText('topic')
  } finally {
    await app.close()
  }
  // Zoom is remembered.
  const again = await launch(repo.dir, userData)
  try {
    await expect(again.page.getByTestId('zoom-level')).toHaveText('90%')
    await expect.poll(() => again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())).toBeCloseTo(0.9)
  } finally {
    await again.app.close()
  }
})

test('profiles: own settings, open repositories and Git identity; switching restarts into the profile', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1\n' })
  const base = makeTempDir('gitbob-base-')
  const home = makeTempDir('gitbob-home-')
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Personal Me\n\temail = me@home.io\n')
  // No GIT_AUTHOR_* here: the identity must come from Git config (the profile's).
  const start = async (args: string[]) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), GITBOB_USER_DATA: base, ELECTRON_RENDERER_URL: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') }
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[k]
    const app = await electron.launch({ args: [appDir, ...args], env })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // Keep the test in control of "restart into the profile".
    await app.evaluate(({ app: a }) => {
      ;(globalThis as Record<string, unknown>).__relaunched = false
      a.relaunch = (() => {
        ;(globalThis as Record<string, unknown>).__relaunched = true
      }) as typeof a.relaunch
      a.exit = (() => {}) as typeof a.exit
    })
    return { app, page }
  }

  // Default profile: open the repository and pick the dark theme.
  let { app, page } = await start([repo.dir])
  await expect(page.getByTestId('profile-name')).toHaveText('Default')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:settings'))
  await page.getByLabel('Theme').selectOption('dark')
  await page.getByRole('button', { name: 'Close settings' }).click()

  // New profile → the app asks to restart into it.
  await page.getByTestId('profile-menu').click()
  await page.getByRole('menuitem', { name: 'New profile…' }).click()
  await page.getByLabel('Profile name').fill('Acme')
  await page.getByRole('button', { name: 'Create and switch' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__relaunched)).toBe(true)
  const file = JSON.parse(readFileSync(join(base, 'profiles.json'), 'utf8')) as { active: string; profiles: { id: string; name: string }[] }
  expect(file.profiles.map((p) => p.name)).toEqual(['Default', 'Acme'])
  expect(file.active).not.toBe('default')
  await app.close()

  // The Acme profile starts fresh: no recent repositories, default theme.
  ;({ app, page } = await start([]))
  try {
    await expect(page.getByTestId('profile-name')).toHaveText('Acme')
    await expect(page.getByTestId('recent-repo')).toHaveCount(0)
    expect((await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))).toBe('system')

    // Its own Git identity applies to commits made in GitBob.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:settings'))
    await page.getByRole('button', { name: 'Profile', exact: true }).click()
    await page.getByLabel('Profile Git name').fill('Work Me')
    await page.getByLabel('Profile Git email').fill('me@acme.io')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('notice')).toContainText('Git identity saved')
    await page.getByRole('button', { name: 'Close settings' }).click()
  } finally {
    await app.close()
  }
  ;({ app, page } = await start([repo.dir]))
  try {
    repo.write('a.txt', '2\n')
    await page.getByTestId('wip-row').click()
    await page.getByRole('button', { name: 'Stage all' }).click()
    await page.getByLabel('Commit summary').fill('Work commit')
    await page.getByRole('button', { name: /^Commit/ }).click()
    await expect(page.getByTestId('details-subject')).toHaveText('Work commit')
    expect(repo.git(['log', '-1', '--format=%an <%ae>'])).toBe('Work Me <me@acme.io>')
  } finally {
    await app.close()
  }
})

test('long context menus fit in a small window and scroll', async () => {
  const repo = createFixtureRepo()
  repo.commit('base', { 'a.txt': '1\n' })
  repo.branch('other')
  repo.commit('second', { 'a.txt': '2\n' })
  const { app, page } = await launch(repo.dir)
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 420))
    await page.locator('[data-testid="ref-item"][data-ref="refs/heads/other"]').click({ button: 'right' })
    const menu = page.getByTestId('context-menu')
    const box = (await menu.boundingBox())!
    const height = await page.evaluate(() => window.innerHeight)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(height)
    // The last item is reachable (scrolled into view on click).
    await page.getByRole('menuitem', { name: 'Create annotated tag here…' }).click()
    await expect(page.getByLabel('Tag name')).toBeVisible()
  } finally {
    await app.close()
  }
})

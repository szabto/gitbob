import { app, BrowserWindow, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc, openAndRegister, type IpcContext } from './ipc'
import { buildMenu } from './menu'
import { RecentRepositoryStore } from './recent'
import { RepositoryWatcher } from './watcher'
import { NetworkSession } from './network'
import { SettingsStore } from './settings'
import { TokenStore } from './tokens'
import { ProviderService } from './providers'

// Allow tests to isolate persisted state.
if (process.env.GITBOB_USER_DATA) app.setPath('userData', resolve(process.env.GITBOB_USER_DATA))

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const rendererFile = join(import.meta.dirname, '../renderer/index.html')
const rendererFileUrl = pathToFileURL(rendererFile).href
// Packaged builds embed the icon via electron-builder; this covers dev runs and Linux/Windows windows.
const iconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(import.meta.dirname, '../../resources/icon.png')

let mainWindow: BrowserWindow | null = null

/**
 * Automated tests and screenshot runs set GITBOB_HIDDEN=1: windows render offscreen and are
 * never shown, and on macOS the app gets no Dock icon and never takes focus, so test runs
 * don't interrupt whoever is using the computer.
 */
const hidden = process.env.GITBOB_HIDDEN === '1'
if (hidden && process.platform === 'darwin') app.setActivationPolicy('accessory')
let activeWatcher: RepositoryWatcher | null = null
let network: NetworkSession | null = null

function isTrustedUrl(url: string): boolean {
  if (rendererDevUrl && url.startsWith(rendererDevUrl)) return true
  return url === rendererFileUrl || url.startsWith(`${rendererFileUrl}#`) || url.startsWith(`${rendererFileUrl}?`)
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  return !!url && isTrustedUrl(url)
}

/** First absolute, non-flag command line argument is treated as a repository to open. */
function repoFromArgs(argv: string[]): string | null {
  const args = argv.slice(app.isPackaged ? 1 : 2)
  const candidate = args.find((a) => !a.startsWith('-') && isAbsolute(a))
  return candidate ?? null
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'GitBob',
    icon: iconPath,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // Hidden test windows must keep rendering and running timers at full speed.
      backgroundThrottling: !hidden,
    },
  })

  if (!hidden) win.once('ready-to-show', () => win.show())

  // The renderer is a single-page app: block all navigation and popups.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (rendererDevUrl) void win.loadURL(rendererDevUrl)
  else void win.loadFile(rendererFile)

  return win
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
})

void app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged && !hidden) app.dock?.setIcon(iconPath)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  const settings = new SettingsStore(app.getPath('userData'))
  // nativeTheme.themeSource themes native dialogs/menus; the renderer gets the choice via IPC.
  nativeTheme.themeSource = (await settings.load()).theme

  network = new NetworkSession({
    usePlatformHelper: () => settings.get().usePlatformCredentialHelper,
    enablePlatformHelper: async () => {
      if (!settings.get().usePlatformCredentialHelper) await settings.update({ usePlatformCredentialHelper: true })
    },
  })

  const ctx: IpcContext = {
    getSettings: () => settings.get(),
    providers: new ProviderService(new TokenStore(app.getPath('userData'))),
    recent: new RecentRepositoryStore(app.getPath('userData')),
    isTrustedSender,
    network,
    onRepositoryOpened: (info) => {
      // One window shows one repository at a time: watch only the most recently opened one.
      activeWatcher?.stop()
      activeWatcher = new RepositoryWatcher(info.root, info.gitDir, () => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('repo:changed', { repoPath: info.root })
      })
      activeWatcher.start()
    },
  }
  registerIpc(ctx)

  const rebuildMenu = (): void =>
    buildMenu(() => mainWindow, {
      theme: settings.get().theme,
      onThemeChange: (theme) => {
        nativeTheme.themeSource = theme
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme:changed', { theme })
        void settings.update({ theme }).then(rebuildMenu)
      },
    })
  rebuildMenu()
  mainWindow = createWindow()

  const initialRepo = repoFromArgs(process.argv)
  if (initialRepo) {
    const win = mainWindow
    win.webContents.once('did-finish-load', () => {
      openAndRegister(initialRepo, ctx)
        .then((info) => win.webContents.send('repo:opened', info))
        .catch((err: unknown) => console.error('Failed to open repository from command line:', err))
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('will-quit', () => {
  activeWatcher?.stop()
  void network?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

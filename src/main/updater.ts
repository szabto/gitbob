import { app, BrowserWindow } from 'electron'
import type { UpdateInfo } from '@shared/types'
import { checkForUpdate as checkReleases } from './app-info'

/**
 * Which update mechanism this installation can use:
 *  - 'auto': electron-updater can download and install in place (Windows NSIS, Linux AppImage).
 *  - 'manual': only tell the user and link to the download (macOS until builds are signed with
 *    a Developer ID — Squirrel.Mac refuses unsigned updates — and Linux .deb, which belongs to
 *    the package manager; also development builds).
 */
export function updateMode(opts: { platform: NodeJS.Platform; isPackaged: boolean; appImage: string | undefined }): 'auto' | 'manual' {
  if (!opts.isPackaged) return 'manual'
  if (opts.platform === 'win32') return 'auto'
  if (opts.platform === 'linux' && opts.appImage) return 'auto'
  return 'manual'
}

type AutoUpdater = typeof import('electron-updater').autoUpdater

/** Update checks only happen on request (or when the user opted into checking at startup). */
export class Updater {
  private updater: AutoUpdater | null = null
  readonly mode = updateMode({ platform: process.platform, isPackaged: app.isPackaged, appImage: process.env.APPIMAGE })

  private broadcast(channel: 'app:update-available' | 'app:update-progress' | 'app:update-downloaded', payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
  }

  private async auto(): Promise<AutoUpdater> {
    if (this.updater) return this.updater
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('download-progress', (p) => this.broadcast('app:update-progress', { percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (i) => this.broadcast('app:update-downloaded', { version: i.version }))
    this.updater = autoUpdater
    return autoUpdater
  }

  async check(): Promise<UpdateInfo & { canInstall: boolean }> {
    const info = await checkReleases()
    return { ...info, canInstall: this.mode === 'auto' && info.newer }
  }

  /** Download the newer version (auto mode only); progress and completion arrive as events. */
  async download(): Promise<void> {
    if (this.mode !== 'auto') throw new Error('This installation updates by downloading the new version from GitHub.')
    const u = await this.auto()
    const res = await u.checkForUpdates()
    if (!res?.isUpdateAvailable) throw new Error('No newer version is available.')
    await u.downloadUpdate()
  }

  /** Quit and install a downloaded update. */
  async install(): Promise<void> {
    const u = await this.auto()
    u.quitAndInstall(false, true)
  }
}

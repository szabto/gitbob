import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.1.0' }, BrowserWindow: { getAllWindows: () => [] } }))

describe('updateMode', () => {
  it('installs in place only where electron-updater can', async () => {
    const { updateMode } = await import('../../src/main/updater')
    expect(updateMode({ platform: 'win32', isPackaged: true, appImage: undefined })).toBe('auto')
    expect(updateMode({ platform: 'linux', isPackaged: true, appImage: '/x/GitBob.AppImage' })).toBe('auto')
    expect(updateMode({ platform: 'linux', isPackaged: true, appImage: undefined })).toBe('manual')
    // Squirrel.Mac refuses updates for apps without a Developer ID signature.
    expect(updateMode({ platform: 'darwin', isPackaged: true, appImage: undefined })).toBe('manual')
    expect(updateMode({ platform: 'win32', isPackaged: false, appImage: undefined })).toBe('manual')
  })
})

describe('isNewer', () => {
  it('compares versions numerically', async () => {
    const { isNewer } = await import('../../src/main/app-info')
    expect(isNewer('0.10.0', '0.9.3')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('v0.2.0', '0.1.9')).toBe(true)
    expect(isNewer('0.2.0-beta', '0.2.0')).toBe(false)
    expect(isNewer('0.2.0', '0.2.0-beta')).toBe(true)
  })
})

describe('loadAutoUpdater', () => {
  it('finds autoUpdater as a named export or on the CommonJS default export', async () => {
    const { loadAutoUpdater } = await import('../../src/main/updater')
    const fake = { checkForUpdates: () => null } as never
    await expect(loadAutoUpdater(async () => ({ autoUpdater: fake }))).resolves.toBe(fake)
    await expect(loadAutoUpdater(async () => ({ default: { autoUpdater: fake } }))).resolves.toBe(fake)
    await expect(loadAutoUpdater(async () => ({}))).rejects.toThrow('not available')
  })

  it('electron-updater only exposes autoUpdater on default when Node imports it as ESM (like the packaged app)', async () => {
    const { execFileSync } = await import('node:child_process')
    // Inspect the property without triggering its getter, which needs a running Electron app.
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "const m = await import('electron-updater'); console.log(JSON.stringify({ named: 'autoUpdater' in m, onDefault: !!Object.getOwnPropertyDescriptor(m.default, 'autoUpdater') }))"],
      { encoding: 'utf8' },
    )
    const { named, onDefault } = JSON.parse(out.trim().split('\n').pop()!) as { named: boolean; onDefault: boolean }
    expect(named || onDefault).toBe(true)
  })
})

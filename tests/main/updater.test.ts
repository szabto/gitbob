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

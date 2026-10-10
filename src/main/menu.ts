import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export interface MenuOptions {
  theme: 'system' | 'light' | 'dark'
  onThemeChange: (theme: 'system' | 'light' | 'dark') => void
}

export function buildMenu(getWindow: () => BrowserWindow | null, opts: MenuOptions): void {
  const isMac = process.platform === 'darwin'
  const send = (channel: string): void => getWindow()?.webContents.send(channel)

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open-repository') },
        { label: 'Clone Repository…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:clone-repository') },
        { label: 'New Repository…', accelerator: 'CmdOrCtrl+Alt+N', click: () => send('menu:init-repository') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: (['system', 'light', 'dark'] as const).map((t) => ({
            label: t === 'system' ? 'Match System' : t === 'light' ? 'Light' : 'Dark',
            type: 'radio' as const,
            checked: opts.theme === t,
            click: () => opts.onThemeChange(t),
          })),
        },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

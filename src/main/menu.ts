import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export interface MenuOptions {
  onZoom: (action: 'in' | 'out' | 'reset') => void
  onSettings: () => void
  theme: 'system' | 'light' | 'dark'
  onThemeChange: (theme: 'system' | 'light' | 'dark') => void
}

export function buildMenu(getWindow: () => BrowserWindow | null, opts: MenuOptions): void {
  const isMac = process.platform === 'darwin'
  const send = (channel: string): void => getWindow()?.webContents.send(channel)

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => opts.onSettings() },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open-repository') },
        { label: 'Clone Repository…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('menu:clone-repository') },
        { label: 'New Repository…', accelerator: 'CmdOrCtrl+Alt+N', click: () => send('menu:init-repository') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'Settings…', accelerator: 'Ctrl+,', click: () => opts.onSettings() }]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: () => send('menu:command-palette') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => opts.onZoom('reset') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => opts.onZoom('in') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true, click: () => opts.onZoom('in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => opts.onZoom('out') },
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

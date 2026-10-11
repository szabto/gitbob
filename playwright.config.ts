import { defineConfig } from '@playwright/test'

// Every launched app inherits this: no visible windows, no Dock icon, no focus stealing.
process.env.GITBOB_HIDDEN = '1'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // Windows CI runners spawn processes (git, the app) several times slower than macOS/Linux.
  expect: { timeout: process.platform === 'win32' ? 15_000 : 5_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})

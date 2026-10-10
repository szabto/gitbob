import { defineConfig } from '@playwright/test'

// Every launched app inherits this: no visible windows, no Dock icon, no focus stealing.
process.env.GITBOB_HIDDEN = '1'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})

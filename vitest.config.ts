import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@git-core': resolve(__dirname, 'src/git-core'),
      '@git-graph': resolve(__dirname, 'src/git-graph'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 30_000,
    pool: 'forks',
  },
})

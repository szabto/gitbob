import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@git-core': resolve(__dirname, 'src/git-core'),
  '@git-graph': resolve(__dirname, 'src/git-graph'),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
  },
  preload: {
    // The preload runs sandboxed, so it must be fully self-contained: no externals.
    resolve: { alias },
    build: {
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        ...alias,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        // monaco-editor's package "exports" map appends .js to every subpath, so its CSS
        // files are only reachable through a direct path.
        'monaco-esm': resolve(__dirname, 'node_modules/monaco-editor/esm/vs'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})

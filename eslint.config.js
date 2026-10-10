import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['site/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // We do not use the React Compiler; this rule only reports skipped compilation.
      'react-hooks/incompatible-library': 'off',
      // Renderer must never touch Node/Electron directly; everything goes through the preload API.
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'electron', 'child_process', 'fs', 'path', '@git-core/*'] },
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      // Git must be executed with argument arrays, never through a shell.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message: 'Never spawn subprocesses through a shell.',
        },
      ],
    },
  },
)

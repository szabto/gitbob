/**
 * Local Monaco setup: the core editor API, the diff editor, a few editing
 * contributions and the basic (Monarch) syntax highlighters for ~80 languages.
 * Heavy language services (TypeScript/JSON/CSS/HTML workers) are deliberately
 * not loaded: GitBob shows and edits text, it is not an IDE. The only worker
 * (used for diff computation) is inlined as a blob so it works from file://.
 */
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter'
import 'monaco-editor/features/find/register'
import 'monaco-editor/editor/common/standaloneStrings'
import 'monaco-esm/base/browser/ui/codicons/codicon/codicon.css'
import 'monaco-esm/base/browser/ui/codicons/codicon/codicon-modifiers.css'
import 'monaco-editor/basic-languages/monaco.contribution'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline'

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker }
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() }

/**
 * Read a color token from CSS as #RRGGBB(AA). The production CSS minifier shortens
 * colors (#ffffff -> #fff), but Monaco only accepts the long forms.
 */
export function cssColor(name: string): string {
  return normalizeHex(getComputedStyle(document.documentElement).getPropertyValue(name).trim())
}

export function normalizeHex(value: string): string {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value)
  if (!m) return ''
  const hex = m[1]!
  if (hex.length === 3 || hex.length === 4) return '#' + [...hex].map((c) => c + c).join('')
  return hex.length === 6 || hex.length === 8 ? `#${hex}` : ''
}

/** Define/refresh the GitBob themes from the current CSS tokens and apply the right one. */
export function applyMonacoTheme(dark: boolean): void {
  const bg = cssColor('--gb-bg') || (dark ? '#0f1115' : '#ffffff')
  const panel = cssColor('--gb-panel') || bg
  const border = cssColor('--gb-border') || '#262b36'
  const fg = cssColor('--gb-fg') || (dark ? '#d7dce5' : '#1d2330')
  monaco.editor.defineTheme('gitbob', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorGutter.background': bg,
      'editorLineNumber.foreground': cssColor('--gb-muted') || '#8b93a3',
      'diffEditor.border': border,
      'editorOverviewRuler.border': border,
      'editorWidget.background': panel,
      'diffEditor.insertedLineBackground': dark ? '#4ade801a' : '#138a431a',
      'diffEditor.removedLineBackground': dark ? '#f871711a' : '#c92a2a1a',
      'diffEditor.insertedTextBackground': dark ? '#4ade8040' : '#138a4333',
      'diffEditor.removedTextBackground': dark ? '#f8717140' : '#c92a2a33',
    },
  })
  monaco.editor.setTheme('gitbob')
}

const extensionToLanguage = new Map<string, string>()
const filenameToLanguage = new Map<string, string>()
for (const lang of monaco.languages.getLanguages()) {
  for (const ext of lang.extensions ?? []) extensionToLanguage.set(ext.toLowerCase(), lang.id)
  for (const name of lang.filenames ?? []) filenameToLanguage.set(name.toLowerCase(), lang.id)
}

/** Monaco language id for a path (by file name, then extension), or plaintext. */
export function languageForPath(path: string): string {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const byName = filenameToLanguage.get(name)
  if (byName) return byName
  const dot = name.lastIndexOf('.')
  return (dot >= 0 && extensionToLanguage.get(name.slice(dot))) || 'plaintext'
}

export { monaco }

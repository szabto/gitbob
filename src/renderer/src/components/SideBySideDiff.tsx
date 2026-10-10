import { useEffect, useRef } from 'react'
import { applyMonacoTheme, languageForPath, monaco } from '../lib/monaco'
import { useIsDark } from '../lib/useIsDark'

/** Read-only Monaco diff editor with syntax highlighting. */
export function SideBySideDiff({
  path,
  original,
  modified,
  inline = false,
}: {
  path: string
  original: string
  modified: string
  inline?: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const dark = useIsDark()

  useEffect(() => {
    applyMonacoTheme(dark)
  }, [dark])

  useEffect(() => {
    if (!container.current) return
    const e = monaco.editor.createDiffEditor(container.current, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      // Monaco falls back to inline below 900px by default; the diff pane is usually narrower.
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 520,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      fontSize: 12,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || undefined,
      ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 },
    })
    editor.current = e
    return () => {
      const model = e.getModel()
      e.dispose()
      model?.original.dispose()
      model?.modified.dispose()
      editor.current = null
    }
  }, [])

  useEffect(() => {
    const e = editor.current
    if (!e) return
    const lang = languageForPath(path)
    const prev = e.getModel()
    e.setModel({
      original: monaco.editor.createModel(original, lang),
      modified: monaco.editor.createModel(modified, lang),
    })
    prev?.original.dispose()
    prev?.modified.dispose()
  }, [path, original, modified])

  useEffect(() => {
    editor.current?.updateOptions({ renderSideBySide: !inline })
  }, [inline])

  return <div ref={container} className="h-full w-full" data-testid="side-by-side-diff" />
}

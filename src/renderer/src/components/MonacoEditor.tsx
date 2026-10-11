import { useEffect, useRef } from 'react'
import { applyMonacoTheme, languageForPath, monaco } from '../lib/monaco'
import { useIsDark } from '../lib/useIsDark'

/**
 * Plain Monaco editor. `value` is applied when it differs from the editor's
 * current text, so parents can push changes (e.g. "use ours") without
 * fighting the user's typing.
 */
export function MonacoEditor({
  path,
  value,
  readOnly = false,
  onChange,
  testId,
  onReady,
}: {
  path: string
  value: string
  readOnly?: boolean
  onChange?: (value: string) => void
  testId?: string
  onReady?: (editor: monaco.editor.IStandaloneCodeEditor) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  /**
   * Recent texts this editor reported through onChange. React may re-render with any of them while
   * the user keeps typing; those are echoes of our own edits, not new values from the parent.
   */
  const emitted = useRef<string[]>([])
  const dark = useIsDark()

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    applyMonacoTheme(dark)
  }, [dark])

  useEffect(() => {
    if (!container.current) return
    const model = monaco.editor.createModel(value, languageForPath(path))
    const e = monaco.editor.create(container.current, {
      model,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || undefined,
    })
    const sub = e.onDidChangeModelContent(() => {
      const text = e.getValue()
      emitted.current.push(text)
      if (emitted.current.length > 20) emitted.current.shift()
      onChangeRef.current?.(text)
    })
    editor.current = e
    onReady?.(e)
    return () => {
      sub.dispose()
      e.dispose()
      model.dispose()
      editor.current = null
    }
    // Created once per path; value updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly])

  useEffect(() => {
    const e = editor.current
    // While typing, React re-renders with text the editor already moved past; applying it would
    // drop the newest keystrokes. Only values that didn't come from this editor are applied.
    if (emitted.current.includes(value)) return
    if (e && e.getValue() !== value) {
      emitted.current = []
      // Keep undo history by editing through the model.
      e.executeEdits('gitbob', [{ range: e.getModel()!.getFullModelRange(), text: value }])
      e.pushUndoStop()
    }
  }, [value])

  return <div ref={container} className="h-full w-full" data-testid={testId} />
}

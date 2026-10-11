import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { call } from '../lib/api'
import { monaco } from '../lib/monaco'
import { useInvalidateRepo } from '../lib/queries'
import { useUiStore } from '../state/ui'
import { MonacoEditor } from './MonacoEditor'

/**
 * Edit a working-tree file in place. Saving refuses if the file changed on disk since it was
 * opened, so edits made by other programs are never overwritten.
 */
export function FileEditor({ repoPath, path, onDone }: { repoPath: string; path: string; onDone: () => void }) {
  const file = useQuery({ queryKey: ['edit-file', repoPath, path], queryFn: () => call('file:read', { repoPath, path }), staleTime: Infinity, gcTime: 0 })
  const [text, setText] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const invalidate = useInvalidateRepo(repoPath)
  const { showError, showNotice } = useUiStore.getState()

  const base = hash ?? file.data?.hash ?? null
  const current = text ?? file.data?.text ?? ''
  const dirty = text !== null && text !== file.data?.text

  const save = async (stage: boolean): Promise<void> => {
    if (!base || busy) return
    setBusy(true)
    try {
      const r = await call('file:write', { repoPath, path, content: current, baseHash: base })
      setHash(r.hash)
      if (stage) await call('index:stage', { repoPath, paths: [path] })
      invalidate({ history: false })
      showNotice(stage ? `Saved and staged ${path}.` : `Saved ${path}.`)
      onDone()
    } catch (e) {
      showError(e)
    } finally {
      setBusy(false)
    }
  }

  // ⌘S / Ctrl+S in the editor saves (the editor keeps the latest handler through the ref).
  const saveRef = useRef<() => void>(() => {})
  useEffect(() => {
    saveRef.current = () => {
      if (dirty) void save(false)
    }
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-editor">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-xs">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-muted">Editing</span>
        <span className="truncate font-mono">{path}</span>
        {dirty && <span className="text-warn">● unsaved</span>}
        <div className="ml-auto flex items-center gap-2">
          {confirmDiscard ? (
            <>
              <span className="text-warn">Discard your edits?</span>
              <button className="rounded border border-err/60 px-2 py-0.5 text-err hover:bg-err/10" onClick={onDone}>
                Discard
              </button>
              <button className="rounded border border-border px-2 py-0.5 hover:bg-panel-2" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded border border-border px-2 py-0.5 hover:bg-panel-2"
                onClick={() => (dirty ? setConfirmDiscard(true) : onDone())}
              >
                Cancel
              </button>
              <button disabled={!dirty || busy} className="rounded border border-border px-2 py-0.5 hover:bg-panel-2 disabled:opacity-40" onClick={() => void save(true)}>
                Save and stage
              </button>
              <button disabled={!dirty || busy} className="rounded bg-accent px-2 py-0.5 font-medium text-on-accent disabled:opacity-40" onClick={() => void save(false)}>
                Save
              </button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {file.isPending ? (
          <div className="p-4 text-muted">Loading…</div>
        ) : file.isError ? (
          <div className="p-4 text-err">{file.error.message}</div>
        ) : (
          <MonacoEditor
            path={path}
            value={current}
            onChange={setText}
            testId="file-editor-monaco"
            onReady={(ed) => {
              ed.focus()
              ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
            }}
          />
        )}
      </div>
    </div>
  )
}

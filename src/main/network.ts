import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'
import { AskpassServer, type AskpassPrompt } from '@git-core/askpass'
import { GitError } from '@git-core/errors'
import type { NetworkOptions } from '@git-core/remotes'

/**
 * Runs network git operations (fetch/pull/push) one at a time with:
 *  - a GIT_ASKPASS bridge that asks the renderer for credentials,
 *  - progress events, and
 *  - cancellation.
 * Credentials only travel renderer -> main -> git helper over local IPC; they
 * are never stored or logged here. Persisting them is left to the user's
 * configured git credential helper (e.g. osxkeychain), which git calls itself.
 */
export class NetworkSession {
  private askpass: AskpassServer
  private started: Promise<void> | null = null
  private current: { controller: AbortController; sender: WebContents } | null = null
  private pending = new Map<string, { resolve: (v: string | null) => void; sender: WebContents }>()

  constructor() {
    this.askpass = new AskpassServer((p) => this.prompt(p))
  }

  private prompt(p: AskpassPrompt): Promise<string | null> {
    const op = this.current
    if (!op || op.sender.isDestroyed()) return Promise.resolve(null)
    const id = randomBytes(16).toString('hex')
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, sender: op.sender })
      op.sender.send('credentials:request', { id, prompt: p.prompt, secret: p.secret })
    })
  }

  respond(id: string, answer: string | null): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(answer)
  }

  private rejectPending(): void {
    for (const [id, p] of this.pending) {
      if (!p.sender.isDestroyed()) p.sender.send('credentials:cancel', { id })
      p.resolve(null)
    }
    this.pending.clear()
  }

  cancel(): boolean {
    if (!this.current) return false
    this.current.controller.abort()
    this.rejectPending()
    return true
  }

  async run<T>(sender: WebContents, fn: (net: NetworkOptions) => Promise<T>): Promise<T> {
    if (this.current) throw new GitError('INVALID_ARGUMENT', 'Another network operation is already running')
    this.started ??= this.askpass.start()
    await this.started
    const controller = new AbortController()
    this.current = { controller, sender }
    let last = 0
    try {
      return await fn({
        env: this.askpass.env(),
        signal: controller.signal,
        onProgress: (p) => {
          // Throttle to ~10 updates/s.
          const now = Date.now()
          if (now - last < 100 && p.percent !== 100) return
          last = now
          if (!sender.isDestroyed()) sender.send('op:progress', p)
        },
      })
    } finally {
      this.current = null
      this.rejectPending()
    }
  }

  async dispose(): Promise<void> {
    this.cancel()
    await this.askpass.stop()
  }
}

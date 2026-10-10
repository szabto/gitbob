import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'
import { AskpassServer, type AskpassPrompt } from '@git-core/askpass'
import { GitError } from '@git-core/errors'
import type { NetworkOptions } from '@git-core/remotes'
import { approveCredential, parseCredentialPrompt, USE_PLATFORM_HELPER } from '@git-core/network-env'

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
  private pending = new Map<string, { resolve: (v: string | null) => void; sender: WebContents; prompt: string }>()
  /** Answers given during the current operation, keyed by "protocol://host", for "remember". */
  private captured = new Map<string, { protocol: string; host: string; username?: string; password?: string; remember: boolean }>()

  /**
   * @param settings read/update the persisted "use platform credential helper" opt-in.
   */
  constructor(
    private readonly settings: {
      usePlatformHelper: () => boolean
      enablePlatformHelper: () => Promise<void>
    },
  ) {
    this.askpass = new AskpassServer((p) => this.prompt(p))
  }

  private prompt(p: AskpassPrompt): Promise<string | null> {
    const op = this.current
    if (!op || op.sender.isDestroyed()) return Promise.resolve(null)
    const id = randomBytes(16).toString('hex')
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, sender: op.sender, prompt: p.prompt })
      // Only git's own https username/password prompts can be remembered (not ssh passphrases).
      const rememberable = parseCredentialPrompt(p.prompt) !== null
      op.sender.send('credentials:request', { id, prompt: p.prompt, secret: p.secret, confirm: p.confirm, rememberable })
    })
  }

  respond(id: string, answer: string | null, remember = false): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    const parsed = answer !== null ? parseCredentialPrompt(p.prompt) : null
    if (parsed) {
      const key = `${parsed.protocol}://${parsed.host}`
      const c = this.captured.get(key) ?? { protocol: parsed.protocol, host: parsed.host, remember: false }
      if (parsed.field === 'username') c.username = answer!
      else {
        c.password = answer!
        c.username ??= parsed.username
      }
      c.remember ||= remember
      this.captured.set(key, c)
    }
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

  async run<T>(sender: WebContents, fn: (net: NetworkOptions) => Promise<T>, cwd: string = process.cwd()): Promise<T> {
    if (this.current) throw new GitError('INVALID_ARGUMENT', 'Another network operation is already running')
    this.started ??= this.askpass.start()
    await this.started
    const controller = new AbortController()
    this.current = { controller, sender }
    this.captured.clear()
    let last = 0
    try {
      const result = await fn({
        env: { ...this.askpass.env(), ...(this.settings.usePlatformHelper() ? { [USE_PLATFORM_HELPER]: '1' } : {}) },
        signal: controller.signal,
        onProgress: (p) => {
          // Throttle to ~10 updates/s.
          const now = Date.now()
          if (now - last < 100 && p.percent !== 100) return
          last = now
          if (!sender.isDestroyed()) sender.send('op:progress', p)
        },
      })
      await this.rememberCaptured(sender, cwd)
      return result
    } finally {
      this.current = null
      this.captured.clear()
      this.rejectPending()
    }
  }

  /** After a successful operation, hand credentials the user asked to remember to git's helpers. */
  private async rememberCaptured(sender: WebContents, cwd: string): Promise<void> {
    for (const c of this.captured.values()) {
      if (!c.remember || !c.username || !c.password) continue
      await this.settings.enablePlatformHelper()
      const saved = await approveCredential(cwd, {
        protocol: c.protocol,
        host: c.host,
        username: c.username,
        password: c.password,
      }).catch(() => false)
      if (!sender.isDestroyed()) {
        sender.send('credentials:saved', { host: c.host, saved })
      }
    }
  }

  async dispose(): Promise<void> {
    this.cancel()
    await this.askpass.stop()
  }
}

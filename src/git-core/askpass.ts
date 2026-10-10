import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * GIT_ASKPASS bridge.
 *
 * Git (and git-credential) invoke $GIT_ASKPASS with a prompt such as
 * "Username for 'https://host': " and read the answer from its stdout. We
 * point GIT_ASKPASS at a tiny helper that connects to a local socket owned by
 * this process (Unix domain socket in a private 0700 temp dir, or a named pipe
 * on Windows), authenticates with a random per-session token, and relays the
 * prompt to `onPrompt`. Answers are never written to disk or logged.
 */

export interface AskpassPrompt {
  prompt: string
  /** True when the answer is a secret (password, token, passphrase). */
  secret: boolean
}

export type PromptHandler = (p: AskpassPrompt) => Promise<string | null>

const HELPER_JS = `'use strict'
const net = require('net')
const prompt = process.argv[2] || ''
const sock = net.connect(process.env.GITBOB_ASKPASS_SOCKET)
let buf = ''
sock.on('connect', () => sock.write(JSON.stringify({ token: process.env.GITBOB_ASKPASS_TOKEN, prompt }) + '\\n'))
sock.on('data', (d) => { buf += d })
sock.on('end', () => {
  try {
    const res = JSON.parse(buf)
    if (typeof res.answer === 'string') { process.stdout.write(res.answer + '\\n'); process.exit(0) }
  } catch {}
  process.exit(1)
})
sock.on('error', () => process.exit(1))
`

export function isSecretPrompt(prompt: string): boolean {
  return /password|passphrase|token|secret/i.test(prompt)
}

export class AskpassServer {
  private server: Server | null = null
  private dir: string | null = null
  private socketPath = ''
  private readonly token = randomBytes(32).toString('hex')
  private helperPath = ''
  private readonly sockets = new Set<Socket>()

  constructor(
    private readonly onPrompt: PromptHandler,
    /** Executable used to run the helper JS. In Electron, process.execPath with ELECTRON_RUN_AS_NODE=1. */
    private readonly nodePath: string = process.execPath,
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    // mkdtemp creates the directory with mode 0700, so only this user can reach the socket.
    this.dir = await mkdtemp(join(tmpdir(), 'gitbob-askpass-'))
    this.socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\gitbob-askpass-${randomBytes(8).toString('hex')}`
        : join(this.dir, 's.sock')

    const js = join(this.dir, 'askpass.cjs')
    await writeFile(js, HELPER_JS, { mode: 0o600 })
    if (process.platform === 'win32') {
      this.helperPath = join(this.dir, 'askpass.cmd')
      await writeFile(this.helperPath, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${this.nodePath}" "${js}" %*\r\n`)
    } else {
      this.helperPath = join(this.dir, 'askpass.sh')
      await writeFile(this.helperPath, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$GITBOB_ASKPASS_NODE" "${js}" "$@"\n`, { mode: 0o700 })
      await chmod(this.helperPath, 0o700)
    }

    this.server = createServer((sock) => this.handle(sock))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.socketPath, () => resolve())
    })
  }

  /** Environment variables that route git's credential prompts to this server. */
  env(): Record<string, string> {
    if (!this.server) throw new Error('AskpassServer not started')
    return {
      GIT_ASKPASS: this.helperPath,
      GITBOB_ASKPASS_SOCKET: this.socketPath,
      GITBOB_ASKPASS_TOKEN: this.token,
      GITBOB_ASKPASS_NODE: this.nodePath,
    }
  }

  private handle(sock: Socket): void {
    this.sockets.add(sock)
    sock.on('close', () => this.sockets.delete(sock))
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('error', () => sock.destroy())
    sock.on('data', (d: string) => {
      buf += d
      if (buf.length > 16_384) return sock.destroy()
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      let req: { token?: unknown; prompt?: unknown }
      try {
        req = JSON.parse(buf.slice(0, nl)) as typeof req
      } catch {
        return sock.destroy()
      }
      if (req.token !== this.token || typeof req.prompt !== 'string') return sock.end('{}')
      const prompt = req.prompt
      this.onPrompt({ prompt, secret: isSecretPrompt(prompt) })
        .then((answer) => sock.end(JSON.stringify(answer === null ? {} : { answer })))
        .catch(() => sock.end('{}'))
    })
  }

  async stop(): Promise<void> {
    // Pending prompts would keep the server open forever; their helpers just exit with failure.
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = null
    if (this.dir) await rm(this.dir, { recursive: true, force: true })
    this.dir = null
  }
}

/** Parse git's `--progress` stderr into a phase and percentage. */
export function parseProgress(chunk: string): { phase: string; percent: number } | null {
  // Lines are separated by \r while updating, \n when a phase finishes. Use the last complete-looking one.
  const parts = chunk.split(/[\r\n]+/).filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d{1,3})%/.exec(parts[i]!)
    if (m) return { phase: m[1]!.trim(), percent: Number(m[2]) }
  }
  return null
}

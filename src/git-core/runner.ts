import { spawn } from 'node:child_process'
import { GitError } from './errors'

export interface RunOptions {
  cwd: string
  /** Kill the process after this many ms. Default 30s. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Abort if stdout grows beyond this many bytes. Default 256 MiB. */
  maxOutputBytes?: number
  /**
   * When stdout exceeds `maxOutputBytes`, stop git and resolve with the first
   * `maxOutputBytes` bytes (and `truncated: true`) instead of rejecting.
   */
  truncateOutput?: boolean
  /** Extra environment variables. */
  env?: Record<string, string>
  /** Data written to stdin. */
  input?: string | Buffer
  /** Exit codes that are not treated as failures. Default [0]. */
  okExitCodes?: number[]
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  /** Set when output was cut at `maxOutputBytes` (only with `truncateOutput`). */
  truncated?: boolean
}

/**
 * Global config overrides applied to every invocation so user configuration
 * cannot change the machine-readable output we parse.
 */
const BASE_CONFIG = [
  '-c', 'color.ui=false',
  '-c', 'core.quotepath=false',
  '-c', 'log.showSignature=false',
  '-c', 'i18n.logOutputEncoding=UTF-8',
]

let gitBinary = 'git'

/** Override the Git executable (e.g. a user-configured custom binary). */
export function setGitBinary(path: string): void {
  gitBinary = path
}

export function getGitBinary(): string {
  return gitBinary
}

const MAX_STDERR = 64 * 1024

/**
 * Run git with an argument array. Never uses a shell; arguments are passed
 * verbatim to the process so no interpolation or injection is possible.
 */
export function runGit(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const maxOut = opts.maxOutputBytes ?? 256 * 1024 * 1024
  const okCodes = opts.okExitCodes ?? [0]

  for (const a of args) {
    if (typeof a !== 'string' || a.includes('\0')) {
      return Promise.reject(new GitError('INVALID_ARGUMENT', 'Invalid git argument'))
    }
  }

  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new GitError('CANCELLED', 'Git command was cancelled'))
      return
    }

    const child = spawn(gitBinary, [...BASE_CONFIG, ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // Never block waiting for interactive credential prompts.
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        LC_ALL: 'C',
        LANG: 'C',
        ...opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const out: Buffer[] = []
    let outLen = 0
    let err = ''
    let settled = false
    let killedReason: 'timeout' | 'cancel' | 'overflow' | null = null

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const kill = (reason: 'timeout' | 'cancel' | 'overflow'): void => {
      killedReason = reason
      child.kill('SIGTERM')
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2000).unref()
    }

    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const onAbort = (): void => kill('cancel')
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      if (killedReason === 'overflow') return
      const room = maxOut - outLen
      outLen += chunk.length
      if (outLen > maxOut) {
        if (opts.truncateOutput && room > 0) out.push(chunk.subarray(0, room))
        if (!killedReason) kill('overflow')
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < MAX_STDERR) err += chunk.toString('utf8')
    })

    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() => {
        if (e.code === 'ENOENT') {
          reject(new GitError('GIT_NOT_FOUND', `Git executable not found: ${gitBinary}`))
        } else {
          reject(new GitError('INTERNAL', `Failed to start git: ${e.message}`))
        }
      })
    })

    // After we kill git, a grandchild (ssh, credential helper, hook) may still hold the
    // stdio pipes open, which would delay 'close' indefinitely. Release them on exit.
    child.on('exit', () => {
      if (killedReason) {
        child.stdout.destroy()
        child.stderr.destroy()
      }
    })

    child.on('close', (code) => {
      finish(() => {
        const stderr = err.trim()
        if (killedReason === 'timeout') {
          reject(new GitError('TIMEOUT', `git ${args[0] ?? ''} timed out after ${timeoutMs} ms`, { detail: stderr }))
          return
        }
        if (killedReason === 'cancel') {
          reject(new GitError('CANCELLED', 'Git command was cancelled'))
          return
        }
        if (killedReason === 'overflow') {
          if (opts.truncateOutput) {
            resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr, exitCode: code ?? -1, truncated: true })
            return
          }
          reject(new GitError('GIT_FAILED', `git ${args[0] ?? ''} produced more than ${maxOut} bytes of output`))
          return
        }
        const exitCode = code ?? -1
        const stdout = Buffer.concat(out).toString('utf8')
        if (!okCodes.includes(exitCode)) {
          reject(
            new GitError('GIT_FAILED', firstLine(stderr) || `git ${args[0] ?? ''} exited with code ${exitCode}`, {
              detail: stderr,
              exitCode,
            }),
          )
          return
        }
        resolve({ stdout, stderr, exitCode })
      })
    })

    child.stdin.on('error', () => {
      /* process may exit before reading stdin; ignore EPIPE */
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? ''
  return line.replace(/^(fatal|error): /, '')
}

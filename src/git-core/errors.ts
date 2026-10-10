import type { AppError, ErrorCode } from '@shared/result'

export class GitError extends Error {
  readonly code: ErrorCode
  readonly detail?: string
  readonly exitCode?: number | null

  constructor(code: ErrorCode, message: string, opts: { detail?: string; exitCode?: number | null } = {}) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.detail = opts.detail
    this.exitCode = opts.exitCode
  }

  toAppError(): AppError {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) }
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof GitError) return err.toAppError()
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message }
  return { code: 'INTERNAL', message: String(err) }
}

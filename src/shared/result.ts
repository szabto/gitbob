/** Envelope used for every IPC response so errors cross the process boundary intact. */

export type ErrorCode =
  | 'NOT_A_REPOSITORY'
  | 'GIT_NOT_FOUND'
  | 'GIT_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'INTERNAL'

export interface AppError {
  code: ErrorCode
  message: string
  /** Optional technical detail (e.g. git stderr). Never contains credentials. */
  detail?: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

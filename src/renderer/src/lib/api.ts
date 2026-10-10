import type { IpcChannel, IpcEventName } from '@shared/channels'
import type { IpcInput } from '@shared/ipc'
import type { IpcEvents, IpcOutputs } from '@shared/ipc-types'
import type { AppError, Result } from '@shared/result'

export class ApiError extends Error {
  readonly code: AppError['code']
  readonly detail?: string
  constructor(err: AppError) {
    super(err.message)
    this.name = 'ApiError'
    this.code = err.code
    this.detail = err.detail
  }
}

/** Typed call into the main process. Throws ApiError on failure. */
export async function call<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutputs[C]> {
  const res = (await window.gitbob.invoke(channel, input)) as Result<IpcOutputs[C]>
  if (!res.ok) throw new ApiError(res.error)
  return res.data
}

export function subscribe<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
  return window.gitbob.on(event, (p) => listener(p as IpcEvents[E]))
}

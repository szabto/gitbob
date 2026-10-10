import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '@shared/channels'

const channels = new Set<string>(IPC_CHANNELS)
const events = new Set<string>(IPC_EVENTS)

/**
 * Minimal, allowlisted bridge. Inputs are validated again in the main process;
 * this layer only prevents access to arbitrary channels.
 */
const api = {
  invoke(channel: string, input: unknown): Promise<unknown> {
    if (!channels.has(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, input)
  },
  on(event: string, listener: (payload: unknown) => void): () => void {
    if (!events.has(event)) throw new Error(`Unknown IPC event: ${event}`)
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('gitbob', api)

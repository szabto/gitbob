/** Shape of the bridge exposed by the preload script as window.gitbob. */
export interface GitBobBridge {
  invoke(channel: string, input: unknown): Promise<unknown>
  on(event: string, listener: (payload: unknown) => void): () => void
  platform: string
}

declare global {
  interface Window {
    gitbob: GitBobBridge
  }
}

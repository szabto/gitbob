import { safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Provider access tokens, encrypted with Electron safeStorage (macOS Keychain, Windows DPAPI,
 * libsecret/kwallet on Linux). Tokens are never written in plaintext: if OS encryption is not
 * available, storing is refused. Keys are "<kind>:<host>".
 *
 * GITBOB_EPHEMERAL_TOKENS=1 (tests only) keeps tokens in memory and never touches the keychain.
 */
export class TokenStore {
  private readonly file: string
  private cache: Record<string, string> | null = null
  private readonly ephemeral = process.env.GITBOB_EPHEMERAL_TOKENS === '1'
  private readonly memory = new Map<string, string>()

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'provider-tokens.json')
  }

  canStore(): boolean {
    return this.ephemeral || safeStorage.isEncryptionAvailable()
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      this.cache = raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  async get(key: string): Promise<string | null> {
    if (this.ephemeral) return this.memory.get(key) ?? null
    const enc = (await this.load())[key]
    if (!enc || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return null
    }
  }

  async set(key: string, token: string): Promise<void> {
    if (this.ephemeral) {
      this.memory.set(key, token)
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure token storage is not available on this system, so the token was not saved.')
    }
    const data = { ...(await this.load()), [key]: safeStorage.encryptString(token).toString('base64') }
    await this.persist(data)
  }

  async delete(key: string): Promise<void> {
    if (this.ephemeral) {
      this.memory.delete(key)
      return
    }
    const data = { ...(await this.load()) }
    delete data[key]
    await this.persist(data)
  }

  private async persist(data: Record<string, string>): Promise<void> {
    this.cache = data
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
  }
}

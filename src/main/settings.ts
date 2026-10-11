import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface Settings {
  theme: ThemeSetting
  /** The user chose "Remember" once: let GitBob's git calls use the OS credential helper. */
  usePlatformCredentialHelper: boolean
  /** Absolute path of a custom git executable; null uses `git` from PATH. */
  gitPath: string | null
  /** Keyboard shortcut overrides: command id -> accelerator (e.g. "Mod+Shift+F"). */
  shortcuts: Record<string, string>
  /** Check GitHub Releases for a newer version at startup (off by default: no network without consent). */
  autoCheckUpdates: boolean
  /** Client id of a GitHub OAuth app for "Sign in with GitHub" (device flow); null uses the built-in one. */
  githubClientId: string | null
  /** Commit author avatars: none (initials), from the repository's hosting service, or also Gravatar. */
  avatars: 'off' | 'hosting' | 'gravatar'
  /** Interface zoom factor (0.5–2). */
  zoom: number
  /** This profile's Git identity; null uses the normal global Git config. */
  gitName: string | null
  gitEmail: string | null
}

const DEFAULTS: Settings = {
  theme: 'system',
  usePlatformCredentialHelper: false,
  gitPath: null,
  shortcuts: {},
  autoCheckUpdates: false,
  githubClientId: null,
  avatars: 'hosting',
  zoom: 1,
  gitName: null,
  gitEmail: null,
}

/** Small JSON settings file in userData. Unknown or invalid values fall back to defaults. */
export class SettingsStore {
  private readonly file: string
  private data: Settings = { ...DEFAULTS }

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'settings.json')
  }

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>
      if (raw.theme === 'system' || raw.theme === 'light' || raw.theme === 'dark') this.data.theme = raw.theme
      if (typeof raw.usePlatformCredentialHelper === 'boolean') this.data.usePlatformCredentialHelper = raw.usePlatformCredentialHelper
      if (typeof raw.gitPath === 'string' && raw.gitPath) this.data.gitPath = raw.gitPath
      if (raw.shortcuts && typeof raw.shortcuts === 'object' && !Array.isArray(raw.shortcuts)) {
        this.data.shortcuts = Object.fromEntries(
          Object.entries(raw.shortcuts).filter(
            (e): e is [string, string] => typeof e[1] === 'string' && e[1].length < 64 && /^[a-z0-9.:-]{1,64}$/i.test(e[0]),
          ),
        )
      }
      if (typeof raw.autoCheckUpdates === 'boolean') this.data.autoCheckUpdates = raw.autoCheckUpdates
      if (typeof raw.gitName === 'string' && raw.gitName.trim() && !/[\r\n\0]/.test(raw.gitName)) this.data.gitName = raw.gitName.trim().slice(0, 200)
      if (typeof raw.gitEmail === 'string' && raw.gitEmail.trim() && !/[\r\n\0]/.test(raw.gitEmail)) this.data.gitEmail = raw.gitEmail.trim().slice(0, 200)
      if (typeof raw.zoom === 'number' && raw.zoom >= 0.5 && raw.zoom <= 2) this.data.zoom = raw.zoom
      if (raw.avatars === 'off' || raw.avatars === 'hosting' || raw.avatars === 'gravatar') this.data.avatars = raw.avatars
      if (typeof raw.githubClientId === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(raw.githubClientId)) this.data.githubClientId = raw.githubClientId
    } catch {
      /* first run or unreadable file: defaults */
    }
    return this.get()
  }

  get(): Settings {
    return { ...this.data, shortcuts: { ...this.data.shortcuts } }
  }

  async update(patch: Partial<Settings>): Promise<void> {
    this.data = { ...this.data, ...patch }
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}

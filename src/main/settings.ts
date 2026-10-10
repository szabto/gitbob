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
}

const DEFAULTS: Settings = {
  theme: 'system',
  usePlatformCredentialHelper: false,
  gitPath: null,
  shortcuts: {},
  autoCheckUpdates: false,
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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface Settings {
  theme: ThemeSetting
}

const DEFAULTS: Settings = { theme: 'system' }

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
    } catch {
      /* first run or unreadable file: defaults */
    }
    return this.get()
  }

  get(): Settings {
    return { ...this.data }
  }

  async update(patch: Partial<Settings>): Promise<void> {
    this.data = { ...this.data, ...patch }
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}

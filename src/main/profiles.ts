import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Profile {
  id: string
  name: string
}

export interface ProfilesFile {
  active: string
  profiles: Profile[]
}

const DEFAULT: ProfilesFile = { active: 'default', profiles: [{ id: 'default', name: 'Default' }] }
const ID_RE = /^[a-z0-9]{1,32}$/

/**
 * Profiles: each has its own data folder (settings, open tabs, recent repositories, tokens, UI
 * state). The first profile keeps using the base folder, so existing data needs no migration.
 * Read synchronously because the data folder must be chosen before the app is ready.
 */
export class ProfileStore {
  private readonly file: string

  constructor(private readonly baseDir: string) {
    this.file = join(baseDir, 'profiles.json')
  }

  read(): ProfilesFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ProfilesFile>
      const profiles = (Array.isArray(raw.profiles) ? raw.profiles : [])
        .filter((p): p is Profile => !!p && typeof p.id === 'string' && ID_RE.test(p.id) && typeof p.name === 'string')
        .map((p) => ({ id: p.id, name: p.name.slice(0, 60) || 'Profile' }))
      if (!profiles.some((p) => p.id === 'default')) profiles.unshift(DEFAULT.profiles[0]!)
      const active = typeof raw.active === 'string' && profiles.some((p) => p.id === raw.active) ? raw.active : 'default'
      return { active, profiles }
    } catch {
      return structuredClone(DEFAULT)
    }
  }

  private write(data: ProfilesFile): void {
    mkdirSync(this.baseDir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, this.file)
  }

  /** Data folder of a profile. */
  dirOf(id: string): string {
    if (!ID_RE.test(id)) throw new Error('Invalid profile id')
    return id === 'default' ? this.baseDir : join(this.baseDir, 'profiles', id)
  }

  activeDir(): string {
    const dir = this.dirOf(this.read().active)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  create(name: string): Profile {
    const clean = cleanName(name)
    const data = this.read()
    const p = { id: randomBytes(6).toString('hex'), name: clean }
    data.profiles.push(p)
    this.write(data)
    mkdirSync(this.dirOf(p.id), { recursive: true })
    return p
  }

  rename(id: string, name: string): void {
    const data = this.read()
    const p = data.profiles.find((x) => x.id === id)
    if (!p) throw new Error('Unknown profile')
    p.name = cleanName(name)
    this.write(data)
  }

  /** Removes a profile from the list (its folder is kept on disk so nothing is lost). */
  remove(id: string): void {
    const data = this.read()
    if (id === 'default') throw new Error('The first profile can’t be removed.')
    if (id === data.active) throw new Error('Switch to another profile before removing this one.')
    data.profiles = data.profiles.filter((p) => p.id !== id)
    this.write(data)
  }

  setActive(id: string): void {
    const data = this.read()
    if (!data.profiles.some((p) => p.id === id)) throw new Error('Unknown profile')
    data.active = id
    this.write(data)
  }
}

function cleanName(name: string): string {
  const n = name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 60)
  if (!n) throw new Error('A profile needs a name.')
  return n
}

/** Quote a value for a git config file. */
function quote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * A profile's Git identity as a global config file that includes the user's normal global config
 * first, so credential helpers, aliases etc. still apply and repository config still wins.
 * Returns the file path, or null when the profile has no identity of its own.
 */
export function writeProfileGitConfig(
  profileDir: string,
  identity: { name: string | null; email: string | null },
  originalGlobal: string | undefined,
): string | null {
  const name = identity.name?.trim() ?? ''
  const email = identity.email?.trim() ?? ''
  if (!name && !email) return null
  if (/[\r\n\0]/.test(name + email)) throw new Error('Invalid name or email')
  const includes = originalGlobal
    ? [originalGlobal]
    : [join(homedir(), '.gitconfig'), join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'config')].filter((p) => existsSync(p))
  const lines = [
    '# Written by GitBob for this profile. Your own global config is included first.',
    ...includes.flatMap((p) => ['[include]', `\tpath = ${quote(p)}`]),
    '[user]',
    ...(name ? [`\tname = ${quote(name)}`] : []),
    ...(email ? [`\temail = ${quote(email)}`] : []),
    '',
  ]
  const file = join(profileDir, 'gitconfig')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(file, lines.join('\n'))
  return file
}

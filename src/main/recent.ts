import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RecentRepository } from '@shared/types'

const MAX_RECENT = 20

/** Persists the recent repository list as JSON in the app's userData directory. */
export class RecentRepositoryStore {
  private readonly file: string
  private cache: RecentRepository[] | null = null
  /** Serializes read-modify-write cycles so concurrent adds never lose entries. */
  private queue: Promise<void> = Promise.resolve()

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'recent-repositories.json')
  }

  async list(): Promise<RecentRepository[]> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      this.cache = Array.isArray(raw) ? raw.filter(isRecent).slice(0, MAX_RECENT) : []
    } catch {
      this.cache = []
    }
    return this.cache
  }

  add(path: string, name: string): Promise<void> {
    const run = this.queue.then(async () => {
      const list = await this.list()
      this.cache = [{ path, name, lastOpened: Date.now() }, ...list.filter((r) => r.path !== path)].slice(
        0,
        MAX_RECENT,
      )
      await this.persist(this.cache)
    })
    this.queue = run.catch(() => {})
    return run
  }

  /** Replace the file atomically so a crash never leaves a truncated file. */
  private async persist(list: RecentRepository[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}

function isRecent(v: unknown): v is RecentRepository {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.path === 'string' && typeof r.name === 'string' && typeof r.lastOpened === 'number'
}

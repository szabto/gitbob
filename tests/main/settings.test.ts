import { afterAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/settings'
import { cleanupFixtures, makeTempDir } from '../helpers/fixture'

afterAll(cleanupFixtures)

describe('SettingsStore', () => {
  it('defaults to the system theme and persists changes', async () => {
    const dir = makeTempDir()
    const s = new SettingsStore(dir)
    expect((await s.load()).theme).toBe('system')
    await s.update({ theme: 'light' })
    expect((await new SettingsStore(dir).load()).theme).toBe('light')
  })

  it('ignores invalid values and corrupt files', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'neon' }))
    expect((await new SettingsStore(dir).load()).theme).toBe('system')
    writeFileSync(join(dir, 'settings.json'), '{oops')
    expect((await new SettingsStore(dir).load()).theme).toBe('system')
  })
})

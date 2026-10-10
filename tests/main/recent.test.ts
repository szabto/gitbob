import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecentRepositoryStore } from '../../src/main/recent'
import { cleanupFixtures, makeTempDir } from '../helpers/fixture'

afterAll(cleanupFixtures)

describe('RecentRepositoryStore', () => {
  it('starts empty, persists entries newest-first and de-duplicates', async () => {
    const dir = makeTempDir()
    const store = new RecentRepositoryStore(dir)
    expect(await store.list()).toEqual([])
    await store.add('/a', 'a')
    await store.add('/b', 'b')
    await store.add('/a', 'a')
    expect((await store.list()).map((r) => r.path)).toEqual(['/a', '/b'])

    const reloaded = new RecentRepositoryStore(dir)
    expect((await reloaded.list()).map((r) => r.path)).toEqual(['/a', '/b'])
  })

  it('caps the list at 20 entries', async () => {
    const store = new RecentRepositoryStore(makeTempDir())
    for (let i = 0; i < 25; i++) await store.add(`/r${i}`, `r${i}`)
    const list = await store.list()
    expect(list).toHaveLength(20)
    expect(list[0]!.path).toBe('/r24')
  })

  it('ignores corrupt or malformed files', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'recent-repositories.json'), '{not json')
    expect(await new RecentRepositoryStore(dir).list()).toEqual([])
    writeFileSync(join(dir, 'recent-repositories.json'), JSON.stringify([{ path: 1 }, { path: '/ok', name: 'ok', lastOpened: 1 }]))
    expect((await new RecentRepositoryStore(dir).list()).map((r) => r.path)).toEqual(['/ok'])
  })

  it('writes valid JSON under concurrent adds', async () => {
    const dir = makeTempDir()
    const store = new RecentRepositoryStore(dir)
    await Promise.all([store.add('/x', 'x'), store.add('/y', 'y'), store.add('/z', 'z')])
    const onDisk = JSON.parse(readFileSync(join(dir, 'recent-repositories.json'), 'utf8')) as { path: string }[]
    expect(onDisk.map((r) => r.path).sort()).toEqual(['/x', '/y', '/z'])
  })
})

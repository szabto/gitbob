import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileStore, writeProfileGitConfig } from '../../src/main/profiles'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

afterEach(cleanupFixtures)

describe('ProfileStore', () => {
  it('starts with a default profile using the base folder, and keeps others in their own folders', () => {
    const base = makeTempDir('gitbob-base-')
    const store = new ProfileStore(base)
    expect(store.read()).toEqual({ active: 'default', profiles: [{ id: 'default', name: 'Default' }] })
    expect(store.activeDir()).toBe(base)
    const work = store.create('  Acme Corp  ')
    expect(work.name).toBe('Acme Corp')
    store.setActive(work.id)
    expect(store.activeDir()).toBe(join(base, 'profiles', work.id))
    store.rename(work.id, 'Acme')
    expect(new ProfileStore(base).read().profiles.map((p) => p.name)).toEqual(['Default', 'Acme'])
  })

  it('refuses to remove the default or the active profile, and survives a corrupt file', () => {
    const base = makeTempDir('gitbob-base-')
    const store = new ProfileStore(base)
    const p = store.create('Side')
    store.setActive(p.id)
    expect(() => store.remove('default')).toThrow()
    expect(() => store.remove(p.id)).toThrow(/Switch to another/)
    store.setActive('default')
    store.remove(p.id)
    expect(store.read().profiles).toHaveLength(1)
    writeFileSync(join(base, 'profiles.json'), '{oops')
    expect(store.read().active).toBe('default')
    expect(() => store.dirOf('../etc')).toThrow()
    expect(() => store.create('   ')).toThrow()
  })
})

describe('writeProfileGitConfig', () => {
  it('sets the identity on top of the included global config; repository config still wins', () => {
    const home = makeTempDir('gitbob-home-')
    const global = join(home, '.gitconfig')
    writeFileSync(global, '[user]\n\tname = Personal Me\n\temail = me@home.io\n[alias]\n\tst = status\n')
    const file = writeProfileGitConfig(makeTempDir('gitbob-prof-'), { name: 'Work "Me"', email: 'me@acme.io' }, global)!
    const repo = createFixtureRepo()
    const env = { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' }
    const get = (k: string) => execFileSync('git', ['config', '--get', k], { cwd: repo.dir, env, encoding: 'utf8' }).trim()
    expect(get('user.email')).toBe('me@acme.io')
    expect(get('user.name')).toBe('Work "Me"')
    expect(get('alias.st')).toBe('status') // included global config still applies
    execFileSync('git', ['config', 'user.email', 'repo@local.io'], { cwd: repo.dir, env })
    expect(get('user.email')).toBe('repo@local.io')
  })

  it('writes nothing without an identity and rejects line breaks', () => {
    expect(writeProfileGitConfig(makeTempDir('gitbob-prof-'), { name: null, email: '' }, undefined)).toBeNull()
    expect(() => writeProfileGitConfig(makeTempDir('gitbob-prof-'), { name: 'a\n[core]', email: 'x@y' }, undefined)).toThrow()
  })
})

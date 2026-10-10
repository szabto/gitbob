import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listSubmodules, parseGitmodules, updateSubmodules } from '@git-core/submodules'
import {
  ALLOW_FILE_PROTOCOL_ENV,
  addSubmodule,
  cleanupFixtures,
  cloneFixtureRepo,
  createFixtureRepo,
} from '../helpers/fixture'

afterEach(cleanupFixtures)

/**
 * Submodule URLs here are local paths. Since git 2.38.1 (CVE-2022-39253) cloning them requires
 * protocol.file.allow=always, which only the tests pass (ALLOW_FILE_PROTOCOL_ENV); production code
 * keeps git's default.
 */
function setup() {
  const sub = createFixtureRepo()
  const s1 = sub.commit('sub 1', { 'lib.txt': '1\n' })
  const superRepo = createFixtureRepo()
  superRepo.commit('init', { 'README': 'r\n' })
  addSubmodule(superRepo, sub, 'libs/my sub')
  return { sub, s1, superRepo }
}

describe('submodules', () => {
  it('returns [] without submodules', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    expect(await listSubmodules(repo.dir)).toEqual([])
  })

  it('lists a clean submodule with its .gitmodules url', async () => {
    const { sub, s1, superRepo } = setup()
    superRepo.git(['config', '-f', '.gitmodules', 'submodule.libs/my sub.branch', 'main'])
    expect(await listSubmodules(superRepo.dir)).toEqual([
      { path: 'libs/my sub', url: sub.dir, sha: s1, status: 'clean', branch: 'main' },
    ])
  })

  it('goes from uninitialized to clean with update --init', async () => {
    const { s1, superRepo } = setup()
    const clone = cloneFixtureRepo(superRepo)
    expect(await listSubmodules(clone.dir)).toEqual([
      expect.objectContaining({ path: 'libs/my sub', sha: s1, status: 'uninitialized' }),
    ])
    // Without init nothing is cloned.
    await updateSubmodules(clone.dir, { init: false, recursive: false, env: ALLOW_FILE_PROTOCOL_ENV })
    expect((await listSubmodules(clone.dir))[0]!.status).toBe('uninitialized')
    // Default git policy refuses local-path clones; surfaced as a clear error.
    await expect(updateSubmodules(clone.dir, { init: true, recursive: true })).rejects.toMatchObject({
      code: 'GIT_FAILED',
    })
    await updateSubmodules(clone.dir, {
      init: true,
      recursive: true,
      paths: ['libs/my sub'],
      env: ALLOW_FILE_PROTOCOL_ENV,
    })
    expect(await listSubmodules(clone.dir)).toEqual([expect.objectContaining({ sha: s1, status: 'clean' })])
    expect(existsSync(join(clone.dir, 'libs/my sub', 'lib.txt'))).toBe(true)
  })

  it('detects a different checked-out commit and modified content', async () => {
    const { sub, s1, superRepo } = setup()
    const s2 = sub.commit('sub 2', { 'lib.txt': '2\n' })
    const inner = join(superRepo.dir, 'libs/my sub')
    superRepo.git(['-C', inner, 'fetch', '-q', 'origin'])
    superRepo.git(['-C', inner, 'checkout', '-q', s2])
    expect(await listSubmodules(superRepo.dir)).toEqual([expect.objectContaining({ sha: s2, status: 'modified' })])

    superRepo.git(['-C', inner, 'checkout', '-q', s1])
    expect((await listSubmodules(superRepo.dir))[0]!.status).toBe('clean')
    writeFileSync(join(inner, 'untracked.txt'), 'u\n')
    expect((await listSubmodules(superRepo.dir))[0]!.status).toBe('clean')
    writeFileSync(join(inner, 'lib.txt'), 'edited\n')
    expect((await listSubmodules(superRepo.dir))[0]!.status).toBe('modified')
  })

  it('validates update paths', async () => {
    const { superRepo } = setup()
    await expect(updateSubmodules(superRepo.dir, { init: true, recursive: false, paths: ['../x'] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })
})

describe('parseGitmodules', () => {
  it('handles names with dots and values with spaces', () => {
    const out = 'submodule.a.b.path\na b\0submodule.a.b.url\nhttps://x/y.git\0submodule.c.path\nc\0'
    expect([...parseGitmodules(out).entries()]).toEqual([
      ['a.b', { path: 'a b', url: 'https://x/y.git' }],
      ['c', { path: 'c' }],
    ])
  })
})

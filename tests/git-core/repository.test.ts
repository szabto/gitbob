import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitError } from '@git-core/errors'
import { openRepository } from '@git-core/repository'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

afterEach(() => {
  cleanupFixtures()
})

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(GitError)
    return (e as GitError).code
  }
  throw new Error('expected rejection')
}

describe('openRepository', () => {
  it('opens a repository root', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    const info = await openRepository(repo.dir)
    expect(info).toEqual({ root: repo.dir, gitDir: join(repo.dir, '.git'), bare: false, name: basename(repo.dir) })
  })

  it('opens an empty (unborn) repository', async () => {
    const repo = createFixtureRepo()
    const info = await openRepository(repo.dir)
    expect(info.root).toBe(repo.dir)
    expect(info.bare).toBe(false)
  })

  it('resolves a subdirectory to the worktree root', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a/b/c.txt': 'x' })
    const info = await openRepository(join(repo.dir, 'a', 'b'))
    expect(info.root).toBe(repo.dir)
    expect(info.gitDir).toBe(join(repo.dir, '.git'))
  })

  it('normalizes non-canonical absolute paths', async () => {
    const repo = createFixtureRepo()
    mkdirSync(join(repo.dir, 'sub'))
    const info = await openRepository(`${repo.dir}/sub/../sub/.`)
    expect(info.root).toBe(repo.dir)
  })

  it('rejects a directory that is not a repository', async () => {
    const dir = makeTempDir('gitbob-norepo-')
    // Guard against the temp dir being inside some repository on this machine.
    const err = await openRepository(dir).catch((e: unknown) => e)
    if (err instanceof GitError) expect(err.code).toBe('NOT_A_REPOSITORY')
    else expect.fail(`temp dir ${dir} unexpectedly resolved as a repository`)
  })

  it('rejects a missing directory with NOT_FOUND', async () => {
    const dir = makeTempDir()
    expect(await codeOf(openRepository(join(dir, 'missing')))).toBe('NOT_FOUND')
  })

  it('rejects a file path with NOT_A_REPOSITORY', async () => {
    const repo = createFixtureRepo()
    const file = join(repo.dir, 'file.txt')
    writeFileSync(file, 'x')
    expect(await codeOf(openRepository(file))).toBe('NOT_A_REPOSITORY')
  })

  it.each(['relative/path', '.', '', './repo'])('rejects relative path %j with INVALID_ARGUMENT', async (p) => {
    expect(await codeOf(openRepository(p))).toBe('INVALID_ARGUMENT')
  })

  it('opens a bare repository', async () => {
    const repo = createFixtureRepo({ bare: true })
    const info = await openRepository(repo.dir)
    expect(info.bare).toBe(true)
    expect(info.gitDir).toBe(repo.dir)
    expect(info.root).toBe(repo.dir)
    expect(info.name).toBe(basename(repo.dir))
  })

  it('opens from inside the .git directory of a non-bare repository', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    const info = await openRepository(join(repo.dir, '.git'))
    expect(info.gitDir).toBe(join(repo.dir, '.git'))
  })
})

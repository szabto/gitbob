import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitError } from '@git-core/errors'
import {
  getLfsStatus,
  installLfs,
  parseLfsLsFiles,
  parseLfsTrackOutput,
  pullLfs,
  trackPattern,
  untrackPattern,
} from '@git-core/lfs'
import { cleanupFixtures, cloneFixtureRepo, createFixtureRepo, hasGitLfs, type FixtureRepo } from '../helpers/fixture'

afterEach(() => cleanupFixtures())

async function expectGitError(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const err = await p.then(
    () => new Error('expected rejection'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).code).toBe(code)
  if (message) expect((err as GitError).message).toMatch(message)
}

const LFS = hasGitLfs()
const BIN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
const POINTER_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/

/** LFS filters configured outside the repository (e.g. a system-wide `git lfs install`)? */
function filtersConfiguredOutside(repo: FixtureRepo): boolean {
  try {
    return repo.git(['config', '--get', 'filter.lfs.process']).length > 0
  } catch {
    return false
  }
}

describe('LFS output parsing', () => {
  it('parses git lfs track JSON and text output', () => {
    const json = JSON.stringify({
      patterns: [
        { pattern: '*.psd', source: '.gitattributes', lockable: false, tracked: true },
        { pattern: 'a/*.png', source: 'a/.gitattributes', tracked: true },
        { pattern: '*.tmp', source: '.gitattributes', tracked: false },
      ],
    })
    expect(parseLfsTrackOutput(json)).toEqual([
      { pattern: '*.psd', source: '.gitattributes' },
      { pattern: 'a/*.png', source: 'a/.gitattributes' },
    ])
    const text = [
      'Listing tracked patterns',
      '    *.psd (.gitattributes)',
      '    my[[:space:]]dir/*.bin (sub dir/.gitattributes)',
      'Listing excluded patterns',
      '    *.txt (.gitattributes)',
    ].join('\n')
    expect(parseLfsTrackOutput(text)).toEqual([
      { pattern: '*.psd', source: '.gitattributes' },
      { pattern: 'my[[:space:]]dir/*.bin', source: 'sub dir/.gitattributes' },
    ])
    expect(parseLfsTrackOutput('')).toEqual([])
  })

  it('parses git lfs ls-files --long output', () => {
    const a = 'c038ae3bc0bc351d1a67b5446f000f21df05e24bdfd434e905afd2c3eaf801e4'
    const b = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'
    expect(parseLfsLsFiles(`${a} * a.bin\n${b} - dir/with space.png\ngarbage\n`)).toEqual([
      { oid: a, downloaded: true, path: 'a.bin' },
      { oid: b, downloaded: false, path: 'dir/with space.png' },
    ])
  })
})

describe.skipIf(LFS)('git-lfs not installed', () => {
  it('reports installed: false without throwing and refuses LFS actions', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'a.txt': 'a\n' })
    expect(await getLfsStatus(repo.dir)).toMatchObject({ installed: false, version: null, trackedPatterns: [], files: [] })
    await expectGitError(installLfs(repo.dir), 'GIT_FAILED', /not installed/)
    await expectGitError(trackPattern(repo.dir, '*.bin'), 'GIT_FAILED', /not installed/)
    await expectGitError(pullLfs(repo.dir), 'GIT_FAILED', /not installed/)
  })
})

// Skipped when `git lfs version` fails: git-lfs is not part of git and must be installed separately.
describe.skipIf(!LFS)('git-lfs (requires git-lfs on PATH)', () => {
  it('installs, tracks, lists files and untracks in a local repository', async () => {
    const repo = createFixtureRepo()
    const outside = filtersConfiguredOutside(repo)
    let s = await getLfsStatus(repo.dir)
    expect(s).toMatchObject({ installed: true, enabledInRepo: outside, trackedPatterns: [], files: [], filesTruncated: false })
    expect(s.version).toMatch(/^git-lfs\/\d/)

    await installLfs(repo.dir)
    expect(repo.git(['config', '--local', '--get', 'filter.lfs.process'])).toMatch(/git-lfs/)
    expect((await getLfsStatus(repo.dir)).enabledInRepo).toBe(true)

    const t = await trackPattern(repo.dir, '*.bin')
    expect(t).toEqual({ changed: true, attributesPath: '.gitattributes', attributesAbsPath: join(repo.dir, '.gitattributes') })
    expect(readFileSync(join(repo.dir, '.gitattributes'), 'utf8')).toMatch(/^\*\.bin filter=lfs diff=lfs merge=lfs -text/m)
    // Not staged: that is left to the user.
    expect(repo.git(['diff', '--cached', '--name-only'])).toBe('')
    expect((await trackPattern(repo.dir, '*.bin')).changed).toBe(false)
    await trackPattern(repo.dir, 'my assets/*.psd')

    repo.write('a.bin', BIN)
    repo.write('nested/b.bin', BIN)
    repo.write('plain.txt', 'text\n')
    repo.git(['add', '-A'])
    repo.commit('add lfs files')
    // The committed blob is a pointer, the worktree keeps the real content.
    expect(repo.git(['cat-file', 'blob', 'HEAD:a.bin']) + '\n').toMatch(POINTER_RE)

    s = await getLfsStatus(repo.dir)
    expect(s.trackedPatterns).toEqual([
      { pattern: '*.bin', source: '.gitattributes' },
      { pattern: 'my[[:space:]]assets/*.psd', source: '.gitattributes' },
    ])
    expect(s.files.map((f) => [f.path, f.downloaded])).toEqual([
      ['a.bin', true],
      ['nested/b.bin', true],
    ])
    expect(s.files[0]!.oid).toMatch(/^[0-9a-f]{64}$/)

    expect((await untrackPattern(repo.dir, '*.bin')).changed).toBe(true)
    expect((await untrackPattern(repo.dir, '*.bin')).changed).toBe(false)
    expect((await getLfsStatus(repo.dir)).trackedPatterns.map((p) => p.pattern)).toEqual(['my[[:space:]]assets/*.psd'])
  })

  it('validates patterns before running git-lfs', async () => {
    const repo = createFixtureRepo()
    for (const bad of ['', '   ', '-x', '--help', '#c', '!neg', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(201)]) {
      await expectGitError(trackPattern(repo.dir, bad), 'INVALID_ARGUMENT')
      await expectGitError(untrackPattern(repo.dir, bad), 'INVALID_ARGUMENT')
    }
  })

  it('reports an unborn repository with no files', async () => {
    const repo = createFixtureRepo()
    expect((await getLfsStatus(repo.dir)).files).toEqual([])
  })

  it('pulls LFS objects from a local remote and replaces the pointers', async () => {
    const seed = createFixtureRepo()
    seed.git(['lfs', 'install', '--local'])
    seed.git(['lfs', 'track', '*.bin'])
    seed.write('a.bin', BIN)
    seed.git(['add', '-A'])
    seed.commit('lfs file')
    const bare = createFixtureRepo({ bare: true })
    seed.git(['remote', 'add', 'origin', bare.dir])
    seed.git(['push', '-q', 'origin', 'main']) // the pre-push hook uploads the LFS object

    // Without LFS filters (isolated config) the clone has pointer files.
    const clone = cloneFixtureRepo(bare)
    if (filtersConfiguredOutside(clone)) return // a system-wide install would smudge on clone
    expect(readFileSync(join(clone.dir, 'a.bin'), 'utf8')).toMatch(POINTER_RE)
    expect((await getLfsStatus(clone.dir)).files).toMatchObject([{ path: 'a.bin', downloaded: false }])

    // Objects download, but the checkout is skipped until LFS is installed for the repo.
    expect(await pullLfs(clone.dir)).toEqual({ checkoutSkipped: true })
    expect(readFileSync(join(clone.dir, 'a.bin'), 'utf8')).toMatch(POINTER_RE)

    await installLfs(clone.dir)
    expect(await pullLfs(clone.dir)).toEqual({ checkoutSkipped: false })
    expect(readFileSync(join(clone.dir, 'a.bin')).equals(BIN)).toBe(true)
    expect((await getLfsStatus(clone.dir)).files).toMatchObject([{ path: 'a.bin', downloaded: true }])
    expect(clone.git(['status', '--porcelain'])).toBe('')
  })

  it('maps a failed pull to a clear error', async () => {
    const seed = createFixtureRepo()
    seed.git(['lfs', 'install', '--local'])
    seed.git(['lfs', 'track', '*.bin'])
    seed.write('a.bin', BIN)
    seed.git(['add', '-A'])
    seed.commit('lfs file')
    // A bare remote that has the commits but never received the LFS objects.
    const bare = createFixtureRepo({ bare: true })
    seed.git(['push', '-q', '--no-verify', bare.dir, 'main'])
    const clone = cloneFixtureRepo(bare)
    if (filtersConfiguredOutside(clone)) return
    await expectGitError(pullLfs(clone.dir), 'GIT_FAILED', /Git LFS could not download/)
  })

  it('cancels a pull through its signal', async () => {
    const repo = createFixtureRepo()
    repo.commit('init')
    const ac = new AbortController()
    ac.abort()
    await expectGitError(pullLfs(repo.dir, { signal: ac.signal }), 'CANCELLED')
  })
})

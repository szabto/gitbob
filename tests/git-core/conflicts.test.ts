import { chmodSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getConflictVersions, saveConflictResolution } from '@git-core/conflicts'
import { GitError } from '@git-core/errors'
import { getStatus } from '@git-core/status'
import { parseConflicts, resolveConflicts } from '@shared/conflict-markers'
import {
  cleanupFixtures,
  createFixtureRepo,
  makeDivergedBranches,
  makeMergeConflict,
  makeTempDir,
  type FixtureRepo,
} from '../helpers/fixture'

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

const read = (repo: FixtureRepo, p: string): string => readFileSync(join(repo.dir, p), 'utf8')

function tryGit(repo: FixtureRepo, args: string[]): void {
  try {
    repo.git(args)
  } catch {
    /* expected: conflict */
  }
}

async function unmergedPaths(repo: FixtureRepo): Promise<string[]> {
  return (await getStatus(repo.dir)).entries.filter((e) => e.kind === 'unmerged').map((e) => e.path)
}

describe('getConflictVersions', () => {
  it('returns base/ours/theirs and the merged text of a merge conflict', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const v = await getConflictVersions(repo.dir, path)
    expect(v).toMatchObject({
      base: 'base\n',
      ours: 'ours\n',
      theirs: 'theirs\n',
      binary: false,
      oursLabel: 'main',
      theirsLabel: 'other',
    })
    const [c] = parseConflicts(v.merged).filter((s) => s.type === 'conflict')
    expect(c).toMatchObject({ ours: 'ours\n', theirs: 'theirs\n' })
  })

  it('handles cherry-pick conflicts', async () => {
    const repo = createFixtureRepo()
    const { theirs, path } = makeDivergedBranches(repo)
    tryGit(repo, ['cherry-pick', theirs])
    const v = await getConflictVersions(repo.dir, path)
    expect(v).toMatchObject({ base: 'base\n', ours: 'ours\n', theirs: 'theirs\n', oursLabel: 'main' })
    expect(v.theirsLabel).toBe('other') // the branch pointing at the picked commit
    expect(v.merged).toContain('<<<<<<<')
  })

  it('reads diff3-style markers including the base section', async () => {
    const repo = createFixtureRepo()
    repo.git(['config', 'merge.conflictStyle', 'diff3'])
    const path = makeMergeConflict(repo)
    const v = await getConflictVersions(repo.dir, path)
    const [c] = parseConflicts(v.merged).filter((s) => s.type === 'conflict')
    expect(c).toMatchObject({ ours: 'ours\n', base: 'base\n', theirs: 'theirs\n' })
  })

  it('handles modify/delete conflicts (missing stage)', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'md.txt': 'base\n' })
    repo.branch('other')
    repo.git(['rm', '-q', 'md.txt'])
    repo.commit('delete')
    repo.checkout('other')
    repo.commit('modify', { 'md.txt': 'modified\n' })
    repo.checkout('main')
    tryGit(repo, ['merge', '-q', '--no-ff', '-m', 'm', 'other'])
    expect(await unmergedPaths(repo)).toEqual(['md.txt'])
    const v = await getConflictVersions(repo.dir, 'md.txt')
    expect(v).toMatchObject({ base: 'base\n', ours: null, theirs: 'modified\n', merged: 'modified\n' })

    // Keep their version and mark resolved.
    await saveConflictResolution(repo.dir, 'md.txt', v.theirs!, { markResolved: true })
    expect(await unmergedPaths(repo)).toEqual([])
    expect(repo.git(['cat-file', 'blob', ':0:md.txt'])).toBe('modified')
  })

  it('handles add/add conflicts (no base)', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'x.txt': 'x\n' })
    repo.branch('other')
    repo.commit('add ours', { 'aa.txt': 'mine\n' })
    repo.checkout('other')
    repo.commit('add theirs', { 'aa.txt': 'yours\n' })
    repo.checkout('main')
    tryGit(repo, ['merge', '-q', '--no-ff', '-m', 'm', 'other'])
    const v = await getConflictVersions(repo.dir, 'aa.txt')
    expect(v).toMatchObject({ base: null, ours: 'mine\n', theirs: 'yours\n' })
  })

  it('flags binary conflicts', async () => {
    const repo = createFixtureRepo()
    const bin = (n: number): Buffer => Buffer.from([0, 1, 2, n])
    repo.commit('base', { 'b.bin': bin(0) })
    repo.branch('other')
    repo.commit('ours', { 'b.bin': bin(1) })
    repo.checkout('other')
    repo.commit('theirs', { 'b.bin': bin(2) })
    repo.checkout('main')
    tryGit(repo, ['merge', '-q', '--no-ff', '-m', 'm', 'other'])
    expect(await getConflictVersions(repo.dir, 'b.bin')).toMatchObject({
      binary: true,
      base: null,
      ours: null,
      theirs: null,
      merged: '',
    })
  })

  it('refuses paths that are not conflicted', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    repo.write('clean.txt', 'c\n')
    await expectGitError(getConflictVersions(repo.dir, 'clean.txt'), 'INVALID_ARGUMENT', /Not a conflicted file/)
    await expectGitError(getConflictVersions(repo.dir, '../x'), 'INVALID_ARGUMENT')
    // A directory prefix of a conflicted file is not itself conflicted.
    const repo2 = createFixtureRepo()
    makeMergeConflict(repo2, 'dir/f.txt')
    await expectGitError(getConflictVersions(repo2.dir, 'dir'), 'INVALID_ARGUMENT')
    expect(path).toBe('conflict.txt')
  })
})

describe('saveConflictResolution', () => {
  it('writes the resolution, keeps it unmerged, then marks it resolved', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const v = await getConflictVersions(repo.dir, path)
    const partial = v.merged.replace('ours\n', 'edited ours\n')
    await saveConflictResolution(repo.dir, path, partial, { markResolved: false })
    expect(read(repo, path)).toBe(partial)
    expect(await unmergedPaths(repo)).toEqual([path])

    const resolved = resolveConflicts(parseConflicts(read(repo, path)), ['both'])
    expect(resolved).toBe('edited ours\ntheirs\n')
    await saveConflictResolution(repo.dir, path, resolved, { markResolved: true })
    expect(read(repo, path)).toBe(resolved)
    expect(await unmergedPaths(repo)).toEqual([])
    expect(repo.git(['cat-file', 'blob', `:0:${path}`])).toBe('edited ours\ntheirs')
    // No temp files left behind.
    expect(readdirSync(repo.dir).filter((f) => f.includes('.gitbob-'))).toEqual([])
    // Further writes are refused now that the path is resolved.
    await expectGitError(saveConflictResolution(repo.dir, path, 'x', { markResolved: false }), 'INVALID_ARGUMENT')
  })

  it('refuses to mark resolved while conflict markers remain', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const before = read(repo, path)
    await expectGitError(
      saveConflictResolution(repo.dir, path, before, { markResolved: true }),
      'INVALID_ARGUMENT',
      /conflict markers/,
    )
    expect(read(repo, path)).toBe(before)
    expect(await unmergedPaths(repo)).toEqual([path])
  })

  it('refuses non-conflicted paths (not an arbitrary file writer)', async () => {
    const repo = createFixtureRepo()
    makeMergeConflict(repo)
    repo.write('other.txt', 'keep\n')
    await expectGitError(
      saveConflictResolution(repo.dir, 'other.txt', 'x', { markResolved: false }),
      'INVALID_ARGUMENT',
      /Not a conflicted file/,
    )
    expect(read(repo, 'other.txt')).toBe('keep\n')
    await expectGitError(saveConflictResolution(repo.dir, 'new.txt', 'x', { markResolved: false }), 'INVALID_ARGUMENT')
    await expectGitError(saveConflictResolution(repo.dir, '../evil', 'x', { markResolved: false }), 'INVALID_ARGUMENT')
  })

  it.skipIf(process.platform === 'win32')('preserves the executable bit', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'run.sh': 'base\n' })
    chmodSync(join(repo.dir, 'run.sh'), 0o755)
    repo.git(['add', 'run.sh'])
    repo.commit('exec')
    repo.branch('other')
    repo.commit('ours', { 'run.sh': 'ours\n' })
    repo.checkout('other')
    repo.commit('theirs', { 'run.sh': 'theirs\n' })
    repo.checkout('main')
    tryGit(repo, ['merge', '-q', '--no-ff', '-m', 'm', 'other'])
    expect(statSync(join(repo.dir, 'run.sh')).mode & 0o777).toBe(0o755)
    await saveConflictResolution(repo.dir, 'run.sh', 'resolved\n', { markResolved: true })
    expect(statSync(join(repo.dir, 'run.sh')).mode & 0o777).toBe(0o755)
    expect(repo.git(['ls-files', '-s', 'run.sh'])).toMatch(/^100755 /)
  })

  it.skipIf(process.platform === 'win32')('refuses to write through symlinks', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const outside = makeTempDir('gitbob-outside-')
    unlinkSync(join(repo.dir, path))
    symlinkSync(join(outside, 'target'), join(repo.dir, path))
    await expectGitError(saveConflictResolution(repo.dir, path, 'x', { markResolved: false }), 'INVALID_ARGUMENT')
    expect(readdirSync(outside)).toEqual([])
  })

  it('preserves CRLF content as given', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    await saveConflictResolution(repo.dir, path, 'a\r\nb\r\n', { markResolved: true })
    expect(readFileSync(join(repo.dir, path)).toString('latin1')).toBe('a\r\nb\r\n')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { abortOperation, cherryPick, continueOperation, reset, revert, skipOperation } from '@git-core/history'
import { applyStash, listStashes } from '@git-core/stash'
import { getOperation, runStatus } from '@git-core/status'
import { cleanupFixtures, createFixtureRepo, makeDivergedBranches, makeMergeConflict, type FixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

const read = (repo: FixtureRepo, p: string): string => readFileSync(join(repo.dir, p), 'utf8')
const subject = (repo: FixtureRepo, rev = 'HEAD'): string => repo.git(['log', '-1', '--format=%s', rev])
const parents = (repo: FixtureRepo, rev = 'HEAD'): string[] => repo.git(['log', '-1', '--format=%P', rev]).split(' ')

async function isClean(repo: FixtureRepo): Promise<boolean> {
  return (await runStatus(repo.dir)).entries.length === 0
}

function linearRepo() {
  const repo = createFixtureRepo()
  const a = repo.commit('a', { 'f.txt': '1\n', 'keep.txt': 'k\n' })
  const b = repo.commit('b', { 'f.txt': '2\n' })
  const c = repo.commit('c', { 'f.txt': '3\n' })
  return { repo, a, b, c }
}

describe('reset', () => {
  it('soft keeps the changes staged', async () => {
    const { repo, b, c } = linearRepo()
    expect(await reset(repo.dir, b, 'soft')).toEqual({ backupStash: null })
    expect(repo.head()).toBe(b)
    const { entries } = await runStatus(repo.dir)
    expect(entries).toEqual([expect.objectContaining({ path: 'f.txt', index: 'M', worktree: '.' })])
    expect(repo.git(['show', ':f.txt'])).toBe(repo.git(['show', `${c}:f.txt`]))
  })

  it('mixed keeps the changes unstaged', async () => {
    const { repo, b } = linearRepo()
    await reset(repo.dir, b.slice(0, 8), 'mixed')
    expect(repo.head()).toBe(b)
    const { entries } = await runStatus(repo.dir)
    expect(entries).toEqual([expect.objectContaining({ path: 'f.txt', index: '.', worktree: 'M' })])
    expect(read(repo, 'f.txt')).toBe('3\n')
  })

  it('hard on a clean tree creates no backup', async () => {
    const { repo, a } = linearRepo()
    expect(await reset(repo.dir, a, 'hard')).toEqual({ backupStash: null })
    expect(repo.head()).toBe(a)
    expect(read(repo, 'f.txt')).toBe('1\n')
    expect(await listStashes(repo.dir)).toEqual([])
  })

  it('hard leaves unrelated untracked files alone and needs no backup for them', async () => {
    const { repo, a } = linearRepo()
    repo.write('scratch.txt', 'mine\n')
    expect(await reset(repo.dir, a, 'hard')).toEqual({ backupStash: null })
    expect(read(repo, 'scratch.txt')).toBe('mine\n')
  })

  it('hard backs up staged and unstaged changes so they can be recovered', async () => {
    const { repo, b } = linearRepo()
    repo.write('keep.txt', 'unstaged edit\n')
    repo.write('added.txt', 'staged new file\n')
    repo.git(['add', 'added.txt'])

    const { backupStash } = await reset(repo.dir, b, 'hard')
    expect(backupStash).toMatch(/^[0-9a-f]{40,64}$/)
    expect(repo.head()).toBe(b)
    expect(await isClean(repo)).toBe(true)
    expect(existsSync(join(repo.dir, 'added.txt'))).toBe(false)

    const [entry] = await listStashes(repo.dir)
    expect(entry).toMatchObject({ sha: backupStash, message: `GitBob: backup before hard reset to ${b}` })

    await applyStash(repo.dir, 0, { pop: true, restoreIndex: true })
    expect(read(repo, 'keep.txt')).toBe('unstaged edit\n')
    expect(read(repo, 'added.txt')).toBe('staged new file\n')
    const { entries } = await runStatus(repo.dir)
    expect(entries.find((e) => e.path === 'added.txt')).toMatchObject({ index: 'A' })
    expect(entries.find((e) => e.path === 'keep.txt')).toMatchObject({ index: '.', worktree: 'M' })
  })

  it('hard backs up untracked and ignored files that the target would overwrite', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'f.txt': '1\n', '.gitignore': 'secret.env\n' })
    repo.git(['switch', '-q', '-c', 'other'])
    repo.write('secret.env', 'committed secret\n')
    repo.write('c.txt', 'from other\n')
    repo.git(['add', '-f', 'secret.env', 'c.txt'])
    repo.git(['commit', '-q', '-m', 'other'])
    const other = repo.head()
    repo.checkout('main')
    repo.write('c.txt', 'my untracked work\n')
    repo.write('secret.env', 'my local secret\n')
    repo.write('unrelated.txt', 'u\n')

    const { backupStash } = await reset(repo.dir, other, 'hard')
    expect(backupStash).not.toBeNull()
    // git itself overwrote the colliding files...
    expect(read(repo, 'c.txt')).toBe('from other\n')
    expect(read(repo, 'secret.env')).toBe('committed secret\n')
    // ...but the originals are kept in the backup's untracked-files parent.
    expect(repo.git(['show', `${backupStash}^3:c.txt`])).toBe('my untracked work')
    expect(repo.git(['show', `${backupStash}^3:secret.env`])).toBe('my local secret')
    expect(repo.git(['ls-tree', '-r', '--name-only', `${backupStash}^3`]).split('\n')).toEqual(['c.txt', 'secret.env'])
    expect(read(repo, 'unrelated.txt')).toBe('u\n')
    expect((await listStashes(repo.dir))[0]?.sha).toBe(backupStash)
  })

  it('refuses a hard reset while files are conflicted, changing nothing', async () => {
    const repo = createFixtureRepo()
    makeMergeConflict(repo)
    const head = repo.head()
    await expect(reset(repo.dir, repo.rev('HEAD~1'), 'hard')).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(repo.head()).toBe(head)
    expect(await getOperation(repo.dir)).toBe('merge')
  })

  it('validates its inputs', async () => {
    const { repo, a } = linearRepo()
    for (const bad of ['HEAD', '--hard', 'HEAD~1', '', 'xyz1']) {
      await expect(reset(repo.dir, bad, 'mixed')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(reset(repo.dir, a, 'keep' as 'hard')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(reset(repo.dir, 'deadbeefdeadbeef', 'soft')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('revert', () => {
  it('reverts a commit with the default message', async () => {
    const { repo, c } = linearRepo()
    await revert(repo.dir, c)
    expect(subject(repo)).toBe('Revert "c"')
    expect(parents(repo)).toEqual([c])
    expect(read(repo, 'f.txt')).toBe('2\n')
  })

  it('reverts a merge commit relative to the first parent by default', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'f.txt': '1\n' })
    repo.git(['switch', '-q', '-c', 'topic'])
    repo.commit('topic', { 'g.txt': 'g\n' })
    repo.checkout('main')
    const merge = repo.merge('topic')
    await revert(repo.dir, merge)
    expect(existsSync(join(repo.dir, 'g.txt'))).toBe(false)
    expect(repo.git(['rev-parse', 'HEAD^{tree}'])).toBe(repo.git(['rev-parse', `${base}^{tree}`]))
    await expect(revert(repo.dir, merge, { mainline: 3 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(revert(repo.dir, merge, { mainline: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('leaves a conflicting revert in progress; abort restores HEAD and a clean tree', async () => {
    const { repo, b, c } = linearRepo()
    await expect(revert(repo.dir, b)).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringContaining('conflicts in f.txt'),
    })
    expect(await getOperation(repo.dir)).toBe('revert')
    // Another operation cannot be started on top.
    await expect(cherryPick(repo.dir, [b])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    expect(await abortOperation(repo.dir)).toEqual({ operation: 'revert' })
    expect(repo.head()).toBe(c)
    expect(await getOperation(repo.dir)).toBeNull()
    expect(await isClean(repo)).toBe(true)
  })

  it('resolve then continue creates the revert commit', async () => {
    const { repo, b, c } = linearRepo()
    await expect(revert(repo.dir, b)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(continueOperation(repo.dir)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('f.txt'),
    })
    repo.write('f.txt', 'resolved\n')
    repo.git(['add', 'f.txt'])
    expect(await continueOperation(repo.dir)).toEqual({ operation: 'revert' })
    expect(subject(repo)).toBe('Revert "b"')
    expect(parents(repo)).toEqual([c])
    expect(read(repo, 'f.txt')).toBe('resolved\n')
    expect(await getOperation(repo.dir)).toBeNull()
  })

  it('validates its inputs', async () => {
    const { repo, c } = linearRepo()
    await expect(revert(repo.dir, '--abort')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(revert(repo.dir, 'HEAD')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(revert(repo.dir, c, { mainline: 1.5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(revert(repo.dir, 'abcdef0123')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('cherryPick', () => {
  it('applies several commits in the given order', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'f.txt': '1\n' })
    repo.git(['switch', '-q', '-c', 'topic'])
    const x = repo.commit('x', { 'x.txt': 'x\n' })
    const y = repo.commit('y', { 'y.txt': 'y\n' })
    repo.checkout('main')
    await cherryPick(repo.dir, [y, x])
    expect(repo.git(['log', '--format=%s', '-3']).split('\n')).toEqual(['x', 'y', 'base'])
    expect(read(repo, 'x.txt')).toBe('x\n')
    expect(read(repo, 'y.txt')).toBe('y\n')
  })

  it('cherry-picks a merge commit using mainline 1 by default', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'f.txt': '1\n' })
    repo.git(['switch', '-q', '-c', 'topic'])
    repo.commit('topic', { 'g.txt': 'g\n' })
    repo.git(['switch', '-q', '-c', 'integration', 'main'])
    const merge = repo.merge('topic')
    repo.checkout('main')
    await cherryPick(repo.dir, [merge])
    expect(read(repo, 'g.txt')).toBe('g\n')
    expect(parents(repo)).toHaveLength(1)
  })

  it('leaves a conflicting cherry-pick in progress; abort restores HEAD and a clean tree', async () => {
    const repo = createFixtureRepo()
    const { ours, theirs, path } = makeDivergedBranches(repo)
    await expect(cherryPick(repo.dir, [theirs])).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringContaining(`conflicts in ${path}`),
    })
    expect(await getOperation(repo.dir)).toBe('cherry-pick')
    expect(read(repo, path)).toContain('<<<<<<<')

    expect(await abortOperation(repo.dir)).toEqual({ operation: 'cherry-pick' })
    expect(repo.head()).toBe(ours)
    expect(read(repo, path)).toBe('ours\n')
    expect(await isClean(repo)).toBe(true)
    expect(await getOperation(repo.dir)).toBeNull()
  })

  it('resolve then continue creates the commit', async () => {
    const repo = createFixtureRepo()
    const { ours, theirs, path } = makeDivergedBranches(repo)
    await expect(cherryPick(repo.dir, [theirs])).rejects.toMatchObject({ code: 'GIT_FAILED' })
    repo.write(path, 'merged\n')
    repo.git(['add', path])
    expect(await continueOperation(repo.dir)).toEqual({ operation: 'cherry-pick' })
    expect(subject(repo)).toBe('theirs')
    expect(parents(repo)).toEqual([ours])
    expect(read(repo, path)).toBe('merged\n')
    expect(await getOperation(repo.dir)).toBeNull()
  })

  it('skip drops the conflicting commit and continues with the rest', async () => {
    const repo = createFixtureRepo()
    const { ours, theirs } = makeDivergedBranches(repo)
    repo.checkout('other')
    const extra = repo.commit('extra', { 'extra.txt': 'e\n' })
    repo.checkout('main')
    await expect(cherryPick(repo.dir, [theirs, extra])).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(await skipOperation(repo.dir)).toEqual({ operation: 'cherry-pick' })
    expect(subject(repo)).toBe('extra')
    expect(parents(repo)).toEqual([ours])
    expect(await getOperation(repo.dir)).toBeNull()
    expect(await isClean(repo)).toBe(true)
  })

  it('does not run over conflicting local changes', async () => {
    const repo = createFixtureRepo()
    const { ours, theirs, path } = makeDivergedBranches(repo)
    repo.write(path, 'local edit\n')
    await expect(cherryPick(repo.dir, [theirs])).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(read(repo, path)).toBe('local edit\n')
    expect(repo.head()).toBe(ours)
  })

  it('validates its inputs', async () => {
    const { repo, b } = linearRepo()
    await expect(cherryPick(repo.dir, [])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(cherryPick(repo.dir, ['--continue'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(cherryPick(repo.dir, [b, 'main'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(cherryPick(repo.dir, ['deadbeefdead'])).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('continueOperation / abortOperation / skipOperation', () => {
  it('report when nothing is in progress', async () => {
    const { repo } = linearRepo()
    await expect(continueOperation(repo.dir)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(abortOperation(repo.dir)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(skipOperation(repo.dir)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('continue concludes a resolved merge without an editor', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const ours = repo.head()
    await expect(skipOperation(repo.dir)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    repo.write(path, 'both\n')
    repo.git(['add', path])
    expect(await continueOperation(repo.dir)).toEqual({ operation: 'merge' })
    expect(parents(repo)).toEqual([ours, repo.rev('other')])
    expect(subject(repo)).toBe('merge other')
    expect(await getOperation(repo.dir)).toBeNull()
  })

  it('abort cancels a conflicted merge', async () => {
    const repo = createFixtureRepo()
    const path = makeMergeConflict(repo)
    const ours = repo.head()
    expect(await abortOperation(repo.dir)).toEqual({ operation: 'merge' })
    expect(repo.head()).toBe(ours)
    expect(read(repo, path)).toBe('ours\n')
    expect(await isClean(repo)).toBe(true)
  })

  it('continues and aborts a conflicted rebase', async () => {
    const repo = createFixtureRepo()
    const { ours, path } = makeDivergedBranches(repo)
    repo.checkout('other')
    const theirs = repo.head()
    try {
      repo.git(['rebase', '-q', 'main'])
    } catch {
      /* expected: conflict */
    }
    expect(await getOperation(repo.dir)).toBe('rebase')
    expect(await abortOperation(repo.dir)).toEqual({ operation: 'rebase' })
    expect(repo.head()).toBe(theirs)

    try {
      repo.git(['rebase', '-q', 'main'])
    } catch {
      /* expected: conflict */
    }
    repo.write(path, 'resolved\n')
    repo.git(['add', path])
    expect(await continueOperation(repo.dir)).toEqual({ operation: 'rebase' })
    expect(await getOperation(repo.dir)).toBeNull()
    expect(parents(repo)).toEqual([ours])
    expect(repo.git(['branch', '--show-current'])).toBe('other')
  })
})

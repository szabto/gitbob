import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addWorktree, listWorktrees, parseWorktreeList, pruneWorktrees, removeWorktree } from '@git-core/worktrees'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

afterEach(cleanupFixtures)

function setup() {
  const repo = createFixtureRepo()
  const c1 = repo.commit('first', { 'f.txt': '1\n' })
  const c2 = repo.commit('second', { 'f.txt': '2\n' })
  repo.branch('feature', c1)
  const parent = makeTempDir('gitbob wt parent ')
  return { repo, c1, c2, parent }
}

describe('worktrees', () => {
  it('lists only the main worktree initially', async () => {
    const { repo, c2 } = setup()
    expect(await listWorktrees(repo.dir)).toEqual([
      {
        path: repo.dir,
        head: c2,
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        isMain: true,
        isCurrent: true,
      },
    ])
  })

  it('adds worktrees for an existing branch, a new branch and a detached HEAD', async () => {
    const { repo, c1, c2, parent } = setup()
    const p1 = join(parent, 'feature wt')
    const p2 = join(parent, 'new')
    const p3 = join(parent, 'detached')
    mkdirSync(p3) // an empty existing directory is fine

    expect(await addWorktree(repo.dir, p1, { branch: 'feature' })).toMatchObject({
      path: p1,
      branch: 'feature',
      head: c1,
      isMain: false,
      isCurrent: false,
    })
    expect(readFileSync(join(p1, 'f.txt'), 'utf8')).toBe('1\n')
    expect(await addWorktree(repo.dir, p2, { newBranch: 'topic', startPoint: c1.slice(0, 8) })).toMatchObject({
      branch: 'topic',
      head: c1,
    })
    expect(repo.rev('topic')).toBe(c1)
    expect(await addWorktree(repo.dir, p3, { detach: true })).toMatchObject({ detached: true, branch: null, head: c2 })

    const list = await listWorktrees(repo.dir)
    expect(list[0]!.path).toBe(repo.dir)
    expect(list.map((w) => w.path).sort()).toEqual([repo.dir, p1, p2, p3].sort())
    // From inside a linked worktree, that one is current.
    const fromLinked = await listWorktrees(p1)
    expect(fromLinked.filter((w) => w.isCurrent).map((w) => w.path)).toEqual([p1])
    expect(fromLinked[0]!.isMain).toBe(true)
  })

  it('validates input and surfaces git refusals', async () => {
    const { repo, parent } = setup()
    const target = join(parent, 'x')
    await expect(addWorktree(repo.dir, 'relative/path', { detach: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(addWorktree(repo.dir, target, {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(addWorktree(repo.dir, target, { branch: 'feature', detach: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(addWorktree(repo.dir, target, { newBranch: '-x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(addWorktree(repo.dir, target, { newBranch: 'a..b' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(addWorktree(repo.dir, target, { newBranch: 'feature' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(addWorktree(repo.dir, target, { branch: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(addWorktree(repo.dir, target, { detach: true, startPoint: 'HEAD~1' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    // Branch already checked out in the main worktree.
    await expect(addWorktree(repo.dir, target, { branch: 'main' })).rejects.toMatchObject({ code: 'GIT_FAILED' })
    mkdirSync(join(parent, 'full'))
    writeFileSync(join(parent, 'full', 'keep.txt'), 'mine\n')
    await expect(addWorktree(repo.dir, join(parent, 'full'), { detach: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(readFileSync(join(parent, 'full', 'keep.txt'), 'utf8')).toBe('mine\n')
    expect(await listWorktrees(repo.dir)).toHaveLength(1)
  })

  it('refuses to remove a dirty worktree without force', async () => {
    const { repo, parent } = setup()
    const p = join(parent, 'wt')
    await addWorktree(repo.dir, p, { branch: 'feature' })
    writeFileSync(join(p, 'f.txt'), 'modified\n')
    await expect(removeWorktree(repo.dir, p, { force: false })).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringMatching(/modified or untracked/),
    })
    expect(readFileSync(join(p, 'f.txt'), 'utf8')).toBe('modified\n')
    await removeWorktree(repo.dir, p, { force: true })
    expect(existsSync(p)).toBe(false)
    expect(await listWorktrees(repo.dir)).toHaveLength(1)
    // The branch survives the worktree.
    expect(repo.git(['branch', '--list', 'feature'])).toContain('feature')
  })

  it('removes a clean worktree and refuses main/current/unknown/locked ones', async () => {
    const { repo, parent } = setup()
    const p = join(parent, 'wt')
    const q = join(parent, 'locked')
    await addWorktree(repo.dir, p, { detach: true })
    await addWorktree(repo.dir, q, { detach: true })
    repo.git(['worktree', 'lock', q])
    expect((await listWorktrees(repo.dir)).find((w) => w.path === q)?.locked).toBe(true)
    await expect(removeWorktree(repo.dir, q, { force: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(removeWorktree(repo.dir, repo.dir, { force: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(removeWorktree(p, p, { force: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(removeWorktree(repo.dir, join(parent, 'other'), { force: false })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await removeWorktree(repo.dir, p, { force: false })
    expect(existsSync(p)).toBe(false)
  })

  it('reports and prunes stale worktrees', async () => {
    const { repo, parent } = setup()
    const p = join(parent, 'gone')
    await addWorktree(repo.dir, p, { detach: true })
    rmSync(p, { recursive: true, force: true })
    expect((await listWorktrees(repo.dir)).find((w) => w.path === p)?.prunable).toBe(true)
    expect(await pruneWorktrees(repo.dir)).toEqual({ pruned: ['gone'] })
    expect(await listWorktrees(repo.dir)).toHaveLength(1)
    expect(await pruneWorktrees(repo.dir)).toEqual({ pruned: [] })
  })

  it('lists a bare repository as the main entry', async () => {
    const bare = createFixtureRepo({ bare: true })
    const [w] = await listWorktrees(bare.dir)
    expect(w).toMatchObject({ path: bare.dir, bare: true, head: null, isMain: true, isCurrent: true })
  })
})

describe('parseWorktreeList', () => {
  it('parses newline output with reasons and unborn heads', () => {
    const out = [
      'worktree /a b',
      'HEAD 0000000000000000000000000000000000000000',
      'branch refs/heads/main',
      '',
      'worktree /c',
      'HEAD 1111111111111111111111111111111111111111',
      'detached',
      'locked reason here',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')
    expect(parseWorktreeList(out, '\n')).toEqual([
      { path: '/a b', head: null, branch: 'main', detached: false, bare: false, locked: false, prunable: false, isMain: true },
      {
        path: '/c',
        head: '1'.repeat(40),
        branch: null,
        detached: true,
        bare: false,
        locked: true,
        prunable: true,
        isMain: false,
      },
    ])
  })
})

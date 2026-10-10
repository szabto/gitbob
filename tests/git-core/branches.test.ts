import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertValidBranchName,
  checkoutDetached,
  checkoutRef,
  createBranch,
  deleteBranch,
  renameBranch,
  setUpstream,
} from '@git-core/branches'
import { getHead, listRefs } from '@git-core/refs'
import { cleanupFixtures, cloneFixtureRepo, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

function repoWithHistory() {
  const repo = createFixtureRepo()
  const a = repo.commit('a', { 'f.txt': 'a\n' })
  const b = repo.commit('b', { 'f.txt': 'b\n' })
  return { repo, a, b }
}

describe('assertValidBranchName', () => {
  it.each(['feature/x', 'fix-1', 'release/2026.10', 'ünïcode'])('accepts %s', async (name) => {
    const { repo } = repoWithHistory()
    await expect(assertValidBranchName(repo.dir, name)).resolves.toBeUndefined()
  })
  it.each(['', '-x', '--force', 'a..b', 'a b', 'x.lock', 'a~1', 'a^', 'a:b', '@{-1}', 'HEAD~', 'refs/../x', 'x/'])(
    'rejects %j',
    async (name) => {
      const { repo } = repoWithHistory()
      await expect(assertValidBranchName(repo.dir, name)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    },
  )
})

describe('createBranch', () => {
  it('creates a branch at a commit without switching', async () => {
    const { repo, a } = repoWithHistory()
    await createBranch(repo.dir, 'topic', { startPoint: a, checkout: false })
    expect(repo.rev('topic')).toBe(a)
    expect((await getHead(repo.dir)).ref).toBe('refs/heads/main')
  })

  it('creates and checks out a branch', async () => {
    const { repo, a } = repoWithHistory()
    await createBranch(repo.dir, 'topic', { startPoint: a, checkout: true })
    expect((await getHead(repo.dir)).ref).toBe('refs/heads/topic')
    expect(readFileSync(join(repo.dir, 'f.txt'), 'utf8')).toBe('a\n')
  })

  it('refuses duplicates and invalid start points', async () => {
    const { repo, a } = repoWithHistory()
    await expect(createBranch(repo.dir, 'main', { startPoint: a, checkout: false })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(createBranch(repo.dir, 'x', { startPoint: 'HEAD', checkout: false })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('does not overwrite local changes when checkout would conflict', async () => {
    const { repo, a } = repoWithHistory()
    repo.write('f.txt', 'local edit\n')
    await expect(createBranch(repo.dir, 'topic', { startPoint: a, checkout: true })).rejects.toMatchObject({
      code: 'GIT_FAILED',
    })
    expect(readFileSync(join(repo.dir, 'f.txt'), 'utf8')).toBe('local edit\n')
    expect((await getHead(repo.dir)).ref).toBe('refs/heads/main')
  })
})

describe('checkoutRef', () => {
  it('switches to a local branch', async () => {
    const { repo, a } = repoWithHistory()
    repo.branch('topic', a)
    await expect(checkoutRef(repo.dir, 'refs/heads/topic')).resolves.toEqual({ branch: 'topic' })
    expect((await getHead(repo.dir)).ref).toBe('refs/heads/topic')
  })

  it('creates a tracking branch for a remote branch, and reuses it afterwards', async () => {
    const { repo: origin, a } = repoWithHistory()
    origin.branch('feature', a)
    const clone = cloneFixtureRepo(origin)
    await expect(checkoutRef(clone.dir, 'refs/remotes/origin/feature')).resolves.toEqual({ branch: 'feature' })
    expect(clone.git(['rev-parse', '--abbrev-ref', 'feature@{upstream}'])).toBe('origin/feature')
    clone.checkout('main')
    await checkoutRef(clone.dir, 'refs/remotes/origin/feature')
    expect((await getHead(clone.dir)).ref).toBe('refs/heads/feature')
  })

  it('rejects unknown and non-branch refs', async () => {
    const { repo } = repoWithHistory()
    await expect(checkoutRef(repo.dir, 'refs/heads/nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(checkoutRef(repo.dir, 'refs/tags/x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('checks out a commit detached', async () => {
    const { repo, a } = repoWithHistory()
    await checkoutDetached(repo.dir, a)
    expect(await getHead(repo.dir)).toMatchObject({ detached: true, sha: a })
  })
})

describe('renameBranch / deleteBranch / setUpstream', () => {
  it('renames a branch', async () => {
    const { repo, a } = repoWithHistory()
    repo.branch('old', a)
    await renameBranch(repo.dir, 'old', 'new')
    const names = (await listRefs(repo.dir)).map((r) => r.name)
    expect(names).toContain('refs/heads/new')
    expect(names).not.toContain('refs/heads/old')
  })

  it('refuses to delete an unmerged branch unless forced', async () => {
    const { repo, a } = repoWithHistory()
    repo.branch('side', a)
    repo.checkout('side')
    repo.commit('side work', { 's.txt': 's' })
    repo.checkout('main')
    await expect(deleteBranch(repo.dir, 'side', { force: false })).rejects.toThrow(/not fully merged/)
    expect((await listRefs(repo.dir)).map((r) => r.name)).toContain('refs/heads/side')
    await deleteBranch(repo.dir, 'side', { force: true })
    expect((await listRefs(repo.dir)).map((r) => r.name)).not.toContain('refs/heads/side')
  })

  it('deletes a merged branch and refuses to delete the current branch', async () => {
    const { repo, a } = repoWithHistory()
    repo.branch('merged', a)
    await deleteBranch(repo.dir, 'merged', { force: false })
    await expect(deleteBranch(repo.dir, 'main', { force: true })).rejects.toMatchObject({ code: 'GIT_FAILED' })
  })

  it('sets and unsets upstream and reports ahead/behind', async () => {
    const { repo: origin } = repoWithHistory()
    const clone = cloneFixtureRepo(origin)
    clone.git(['branch', 'local', 'origin/main'])
    await setUpstream(clone.dir, 'local', 'origin/main')
    clone.checkout('local')
    clone.commit('ahead one', { 'x.txt': 'x' })
    let local = (await listRefs(clone.dir)).find((r) => r.name === 'refs/heads/local')!
    expect(local).toMatchObject({ upstream: 'refs/remotes/origin/main', ahead: 1, behind: 0 })
    await setUpstream(clone.dir, 'local', null)
    local = (await listRefs(clone.dir)).find((r) => r.name === 'refs/heads/local')!
    expect(local.upstream).toBeUndefined()
    await expect(setUpstream(clone.dir, 'local', 'origin/nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

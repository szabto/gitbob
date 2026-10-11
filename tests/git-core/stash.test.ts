import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyStash, createStash, dropStash, getStashFiles, listStashes, parseStashSubject } from '@git-core/stash'
import { getOperation, runStatus } from '@git-core/status'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

function repoWithCommit() {
  const repo = createFixtureRepo()
  const base = repo.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  return { repo, base }
}

const read = (dir: string, p: string): string => readFileSync(join(dir, p), 'utf8')

describe('parseStashSubject', () => {
  it('parses named, WIP and detached subjects', () => {
    expect(parseStashSubject('On main: my work')).toEqual({ branch: 'main', message: 'my work' })
    expect(parseStashSubject('WIP on feature/x: abc1234 subject')).toEqual({
      branch: 'feature/x',
      message: 'WIP on feature/x: abc1234 subject',
    })
    expect(parseStashSubject('On (no branch): msg')).toEqual({ branch: null, message: 'msg' })
    expect(parseStashSubject('something else')).toEqual({ branch: null, message: 'something else' })
  })
})

describe('listStashes', () => {
  it('returns [] for an empty repository and a repository without stashes', async () => {
    const empty = createFixtureRepo()
    expect(await listStashes(empty.dir)).toEqual([])
    const { repo } = repoWithCommit()
    expect(await listStashes(repo.dir)).toEqual([])
  })

  it('lists stashes newest first with branch, message and sha', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'one\n')
    expect(await createStash(repo.dir, { message: 'first', includeUntracked: false })).toEqual({ created: true })
    repo.write('a.txt', 'two\n')
    expect(await createStash(repo.dir, { includeUntracked: false })).toEqual({ created: true })

    const list = await listStashes(repo.dir)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ index: 0, ref: 'stash@{0}', branch: 'main', sha: repo.rev('stash@{0}') })
    expect(list[0]?.message).toMatch(/^WIP on main: [0-9a-f]+ base$/)
    expect(list[1]).toMatchObject({ index: 1, ref: 'stash@{1}', branch: 'main', message: 'first', sha: repo.rev('stash@{1}') })
    expect(list[1]?.time).toBeGreaterThan(0)
  })
})

describe('createStash', () => {
  it('reports created:false when there is nothing to stash', async () => {
    const { repo } = repoWithCommit()
    expect(await createStash(repo.dir, { includeUntracked: true })).toEqual({ created: false })
    expect(await listStashes(repo.dir)).toEqual([])
  })

  it('stashes untracked files only when asked', async () => {
    const { repo } = repoWithCommit()
    repo.write('new.txt', 'n\n')
    expect(await createStash(repo.dir, { includeUntracked: false })).toEqual({ created: false })
    expect(existsSync(join(repo.dir, 'new.txt'))).toBe(true)
    expect(await createStash(repo.dir, { includeUntracked: true, message: 'with untracked' })).toEqual({ created: true })
    expect(existsSync(join(repo.dir, 'new.txt'))).toBe(false)
  })

  it('keeps the index and limits to paths', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'staged\n')
    repo.git(['add', 'a.txt'])
    repo.write('b.txt', 'unstaged\n')
    await createStash(repo.dir, { includeUntracked: false, paths: ['b.txt'] })
    expect(read(repo.dir, 'b.txt')).toBe('b\n')
    expect(read(repo.dir, 'a.txt')).toBe('staged\n')

    repo.write('b.txt', 'again\n')
    await createStash(repo.dir, { includeUntracked: false, keepIndex: true })
    expect(read(repo.dir, 'a.txt')).toBe('staged\n')
    expect(read(repo.dir, 'b.txt')).toBe('b\n')
    expect(await listStashes(repo.dir)).toHaveLength(2)
  })

  it('treats option-like messages literally', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'x\n')
    await createStash(repo.dir, { includeUntracked: false, message: '--include-untracked' })
    expect((await listStashes(repo.dir))[0]?.message).toBe('--include-untracked')
  })

  it('rejects invalid paths and fails clearly before the first commit', async () => {
    const { repo } = repoWithCommit()
    await expect(createStash(repo.dir, { includeUntracked: false, paths: ['../x'] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    const empty = createFixtureRepo()
    empty.write('f.txt', 'x')
    empty.git(['add', 'f.txt'])
    await expect(createStash(empty.dir, { includeUntracked: false })).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: 'Cannot stash before the first commit',
    })
  })
})

describe('applyStash / dropStash', () => {
  it('applies (keeping the entry) and pops (removing it)', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'changed\n')
    await createStash(repo.dir, { includeUntracked: false })
    await applyStash(repo.dir, 0, { pop: false })
    expect(read(repo.dir, 'a.txt')).toBe('changed\n')
    expect(await listStashes(repo.dir)).toHaveLength(1)

    repo.git(['checkout', '--', 'a.txt'])
    await applyStash(repo.dir, 0, { pop: true })
    expect(read(repo.dir, 'a.txt')).toBe('changed\n')
    expect(await listStashes(repo.dir)).toEqual([])
  })

  it('restores the index when asked', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'staged\n')
    repo.git(['add', 'a.txt'])
    await createStash(repo.dir, { includeUntracked: false })
    await applyStash(repo.dir, 0, { pop: false, restoreIndex: true })
    const { entries } = await runStatus(repo.dir)
    expect(entries.find((e) => e.path === 'a.txt')).toMatchObject({ index: 'M', worktree: '.' })
  })

  it('reports conflicts on pop and keeps the stash', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'stashed\n')
    await createStash(repo.dir, { includeUntracked: false })
    const sha = repo.rev('stash@{0}')
    repo.commit('diverge', { 'a.txt': 'committed\n' })

    await expect(applyStash(repo.dir, 0, { pop: true })).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringContaining('conflicts in a.txt'),
    })
    const list = await listStashes(repo.dir)
    expect(list).toHaveLength(1)
    expect(list[0]?.sha).toBe(sha)
    expect(read(repo.dir, 'a.txt')).toContain('<<<<<<<')
    expect(await getOperation(repo.dir)).toBeNull()
  })

  it('refuses to apply over conflicting local changes without touching them', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'stashed\n')
    await createStash(repo.dir, { includeUntracked: false })
    repo.write('a.txt', 'local\n')
    await expect(applyStash(repo.dir, 0, { pop: true })).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(read(repo.dir, 'a.txt')).toBe('local\n')
    expect(await listStashes(repo.dir)).toHaveLength(1)
  })

  it('drops a specific entry', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', '1\n')
    await createStash(repo.dir, { includeUntracked: false, message: 'one' })
    repo.write('a.txt', '2\n')
    await createStash(repo.dir, { includeUntracked: false, message: 'two' })
    await dropStash(repo.dir, 1)
    expect((await listStashes(repo.dir)).map((s) => s.message)).toEqual(['two'])
  })

  it('validates the index and the expected sha', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', '1\n')
    await createStash(repo.dir, { includeUntracked: false })
    const sha = repo.rev('stash@{0}')
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(dropStash(repo.dir, bad)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(dropStash(repo.dir, 3)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(dropStash(repo.dir, 0, { expectedSha: '--all' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(dropStash(repo.dir, 0, { expectedSha: 'deadbeef' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(await listStashes(repo.dir)).toHaveLength(1)
    await dropStash(repo.dir, 0, { expectedSha: sha })
    expect(await listStashes(repo.dir)).toEqual([])
  })
})

describe('getStashFiles', () => {
  it('lists tracked changes and untracked files stored in the stash', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'a\nmore\n')
    repo.git(['rm', '-q', 'b.txt'])
    repo.write('dir/new.txt', 'n1\nn2\n')
    await createStash(repo.dir, { includeUntracked: true })

    const files = await getStashFiles(repo.dir, 0)
    expect(files).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'a.txt', additions: 1, deletions: 0 },
        { status: 'D', path: 'b.txt', additions: 0, deletions: 1 },
        { status: 'A', path: 'dir/new.txt', additions: 2, deletions: 0, untrackedIn: expect.stringMatching(/^[0-9a-f]{40}$/) },
      ]),
    )
    expect(files).toHaveLength(3)
  })

  it('works for stashes without untracked files', async () => {
    const { repo } = repoWithCommit()
    repo.write('a.txt', 'x\n')
    await createStash(repo.dir, { includeUntracked: false })
    expect(await getStashFiles(repo.dir, 0)).toEqual([{ status: 'M', path: 'a.txt', additions: 1, deletions: 1 }])
    await expect(getStashFiles(repo.dir, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

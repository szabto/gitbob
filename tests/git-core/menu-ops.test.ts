import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fastForwardBranch } from '@git-core/branches'
import { getWorktreeCompareFiles, saveCommitPatch } from '@git-core/compare'
import { getFileDiff } from '@git-core/diff'
import { getFileContents } from '@git-core/contents'
import { rebaseOnto, rewordHead } from '@git-core/history'
import { deleteRemoteBranch } from '@git-core/remotes'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

afterEach(cleanupFixtures)

describe('operations behind the branch and commit menus', () => {
  it('rewords HEAD without committing staged changes', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n' })
    const old = repo.commit('typo mesage', { 'a.txt': '2\n' })
    repo.write('a.txt', 'staged\n')
    repo.git(['add', 'a.txt'])
    await rewordHead(repo.dir, 'Fixed message\n\nWith body')
    expect(repo.git(['log', '-1', '--format=%B'])).toBe('Fixed message\n\nWith body')
    expect(repo.head()).not.toBe(old)
    expect(repo.git(['diff', '--cached', '--name-only'])).toBe('a.txt')
    expect(repo.git(['show', 'HEAD:a.txt'])).toBe('2')
    await expect(rewordHead(repo.dir, '   ')).rejects.toThrow(/empty/)
  })

  it('fast-forwards a branch that is not checked out, and only if it is a fast-forward', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'a.txt': '1\n' })
    repo.branch('behind')
    repo.branch('diverged')
    const tip = repo.commit('more', { 'a.txt': '2\n' })
    expect(await fastForwardBranch(repo.dir, 'behind', 'refs/heads/main')).toEqual({ moved: true })
    expect(repo.rev('behind')).toBe(tip)
    expect(await fastForwardBranch(repo.dir, 'behind', 'refs/heads/main')).toEqual({ moved: false })
    repo.checkout('diverged')
    repo.commit('other', { 'b.txt': 'x\n' })
    repo.checkout('main')
    await expect(fastForwardBranch(repo.dir, 'diverged', 'refs/heads/main')).rejects.toThrow(/can't be fast-forwarded/)
    await expect(fastForwardBranch(repo.dir, 'main', 'refs/heads/behind')).rejects.toThrow(/checked out/)
    expect(repo.rev('diverged')).not.toBe(base)
  })

  it('deletes a branch on the remote only', async () => {
    const server = createFixtureRepo({ bare: true })
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n' })
    repo.branch('old')
    repo.git(['remote', 'add', 'origin', server.dir])
    repo.git(['push', '-q', 'origin', 'main', 'old'])
    await deleteRemoteBranch(repo.dir, { remote: 'origin', branch: 'old' })
    expect(server.git(['branch', '--list', 'old'])).toBe('')
    expect(repo.git(['branch', '--list', 'old'])).toBe('old')
    await expect(deleteRemoteBranch(repo.dir, { remote: '--upload-pack=x', branch: 'old' })).rejects.toThrow()
  })

  it('compares a commit with the working tree and diffs one file', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'a.txt': 'one\n', 'b.txt': 'b\n' })
    repo.commit('later', { 'a.txt': 'two\n' })
    repo.write('a.txt', 'three\n')
    const files = await getWorktreeCompareFiles(repo.dir, base)
    expect(files.map((f) => [f.status, f.path])).toEqual([['M', 'a.txt']])
    const diff = await getFileDiff(repo.dir, { kind: 'worktree-compare', sha: base, path: 'a.txt' })
    expect(diff.hunks[0]!.lines.map((l) => l.type + l.content)).toEqual(['delone', 'addthree'])
    expect(await getFileContents(repo.dir, { kind: 'worktree-compare', sha: base, path: 'a.txt' })).toMatchObject({ oldText: 'one\n', newText: 'three\n' })
  })

  it('saves a commit as a patch file that git can apply', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n' })
    const c = repo.commit('Add b', { 'b.txt': 'bee\n', 'bin.dat': Buffer.from([0, 255, 1]) })
    const dest = join(makeTempDir('gitbob-patch-out-'), 'x.patch')
    await saveCommitPatch(repo.dir, c, dest)
    const text = readFileSync(dest, 'utf8')
    expect(text).toContain('Subject: [PATCH] Add b')
    expect(text).toContain('GIT binary patch')
    const other = createFixtureRepo()
    other.commit('base', { 'a.txt': '1\n' })
    other.git(['am', '-q', dest])
    expect(existsSync(join(other.dir, 'bin.dat'))).toBe(true)
    expect([...readFileSync(join(other.dir, 'bin.dat'))]).toEqual([0, 255, 1])
  })

  it('rebases onto a plain commit', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n' })
    repo.branch('feature')
    const onMain = repo.commit('main work', { 'm.txt': 'm\n' })
    repo.checkout('feature')
    repo.commit('feature work', { 'f.txt': 'f\n' })
    await rebaseOnto(repo.dir, onMain)
    expect(repo.git(['log', '--format=%s', '-2'])).toBe('feature work\nmain work')
  })
})

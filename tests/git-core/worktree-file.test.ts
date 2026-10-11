import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileForEdit, saveEditedFile } from '@git-core/worktree-file'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

afterEach(cleanupFixtures)

describe('editing working-tree files', () => {
  it('reads with a hash and saves when the file is unchanged on disk', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': 'one\r\ntwo\r\n' })
    const { text, hash } = await readFileForEdit(repo.dir, 'a.txt')
    expect(text).toBe('one\r\ntwo\r\n')
    const saved = await saveEditedFile(repo.dir, 'a.txt', 'one\r\nTWO\r\n', hash)
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('one\r\nTWO\r\n')
    expect(saved.hash).not.toBe(hash)
    // The returned hash allows saving again.
    await saveEditedFile(repo.dir, 'a.txt', 'three\r\n', saved.hash)
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('three\r\n')
  })

  it('refuses to overwrite a change made by another program', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': 'one\n' })
    const { hash } = await readFileForEdit(repo.dir, 'a.txt')
    writeFileSync(join(repo.dir, 'a.txt'), 'edited elsewhere\n')
    await expect(saveEditedFile(repo.dir, 'a.txt', 'mine\n', hash)).rejects.toThrow(/changed outside GitBob/)
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('edited elsewhere\n')
  })

  it.skipIf(process.platform === 'win32')('keeps the executable bit', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'run.sh': 'echo 1\n' })
    chmodSync(join(repo.dir, 'run.sh'), 0o755)
    const { hash } = await readFileForEdit(repo.dir, 'run.sh')
    await saveEditedFile(repo.dir, 'run.sh', 'echo 2\n', hash)
    expect(statSync(join(repo.dir, 'run.sh')).mode & 0o777).toBe(0o755)
  })

  it('rejects binary files, symlinks, .git paths and paths outside the repository', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'bin.dat': Buffer.from([0, 1, 2, 3]), 'a.txt': 'x' })
    await expect(readFileForEdit(repo.dir, 'bin.dat')).rejects.toThrow(/Binary/)
    await expect(readFileForEdit(repo.dir, '.git/config')).rejects.toThrow(/Invalid path/)
    await expect(readFileForEdit(repo.dir, '../outside.txt')).rejects.toThrow()
    await expect(readFileForEdit(repo.dir, 'missing.txt')).rejects.toThrow(/does not exist/)
    await expect(saveEditedFile(repo.dir, 'a.txt', 'y', 'not-a-hash')).rejects.toThrow(/Invalid content hash/)
    if (process.platform !== 'win32') {
      const outside = join(makeTempDir('gitbob-outside-'), 'secret.txt')
      writeFileSync(outside, 'secret')
      symlinkSync(outside, join(repo.dir, 'link.txt'))
      await expect(readFileForEdit(repo.dir, 'link.txt')).rejects.toThrow()
      expect(readFileSync(outside, 'utf8')).toBe('secret')
    }
  })
})

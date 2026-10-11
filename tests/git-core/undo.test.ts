import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reset } from '@git-core/history'
import { applyUndoSteps, headSnapshot, readRef, StaleUndoError } from '@git-core/undo'
import { UndoJournal } from '../../src/main/undo'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

const MAIN = 'refs/heads/main'

describe('undo steps', () => {
  it('undoes a commit softly (changes come back staged) and redoes it', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'a.txt': '1\n' })
    const before = await headSnapshot(repo.dir)
    const second = repo.commit('second', { 'a.txt': '2\n' })
    const after = await headSnapshot(repo.dir)
    expect(after).toEqual({ sha: second, ref: MAIN })

    await applyUndoSteps(repo.dir, [{ type: 'reset', mode: 'soft', expect: after, to: base }])
    expect(repo.head()).toBe(base)
    expect(repo.git(['diff', '--cached', '--name-only'])).toBe('a.txt')
    await applyUndoSteps(repo.dir, [{ type: 'reset', mode: 'soft', expect: before, to: second }])
    expect(repo.head()).toBe(second)
    expect(repo.git(['status', '--porcelain'])).toBe('')
  })

  it('refuses when the repository moved on since the action', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'a.txt': '1\n' })
    repo.commit('second', { 'a.txt': '2\n' })
    const after = await headSnapshot(repo.dir)
    const outside = repo.commit('made outside GitBob', { 'b.txt': 'x\n' })
    await expect(applyUndoSteps(repo.dir, [{ type: 'reset', mode: 'soft', expect: after, to: base }])).rejects.toBeInstanceOf(StaleUndoError)
    expect(repo.head()).toBe(outside)
  })

  it('reset --keep never overwrites uncommitted changes', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'a.txt': '1\n' })
    repo.commit('picked', { 'a.txt': '2\n' })
    const after = await headSnapshot(repo.dir)
    repo.write('a.txt', 'my unsaved work\n')
    await expect(applyUndoSteps(repo.dir, [{ type: 'reset', mode: 'keep', expect: after, to: base }])).rejects.toThrow()
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('my unsaved work\n')
    expect(repo.head()).toBe(after.sha)
  })

  it('recreates and deletes refs only when they still have the expected value', async () => {
    const repo = createFixtureRepo()
    const sha = repo.commit('base', { 'a.txt': '1\n' })
    const ref = 'refs/heads/feature'
    await applyUndoSteps(repo.dir, [{ type: 'ref', ref, from: null, to: sha }])
    expect(await readRef(repo.dir, ref)).toBe(sha)
    await expect(applyUndoSteps(repo.dir, [{ type: 'ref', ref, from: null, to: sha }])).rejects.toBeInstanceOf(StaleUndoError)
    const moved = repo.commit('more', { 'a.txt': '2\n' })
    repo.git(['update-ref', ref, moved])
    await expect(applyUndoSteps(repo.dir, [{ type: 'ref', ref, from: sha, to: null }])).rejects.toBeInstanceOf(StaleUndoError)
    expect(await readRef(repo.dir, ref)).toBe(moved)
    // The checked-out branch is never deleted.
    await expect(applyUndoSteps(repo.dir, [{ type: 'ref', ref: MAIN, from: moved, to: null }])).rejects.toThrow(/checked out/)
    await expect(applyUndoSteps(repo.dir, [{ type: 'ref', ref: 'refs/heads/../x', from: null, to: sha }])).rejects.toThrow(/Invalid ref/)
  })

  it('undoes a hard reset and restores the backed-up local changes', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'a.txt': '1\n' })
    const tip = repo.commit('tip', { 'a.txt': '2\n' })
    repo.write('a.txt', 'unsaved\n')
    const before = await headSnapshot(repo.dir)
    const { backupStash } = await reset(repo.dir, base, 'hard')
    const after = await headSnapshot(repo.dir)
    expect(backupStash).toMatch(/^[0-9a-f]{40}$/)
    await applyUndoSteps(repo.dir, [{ type: 'restore-hard-reset', expect: after, to: tip, backupStash }])
    expect(repo.head()).toBe(tip)
    expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe('unsaved\n')
    expect(before).toEqual({ sha: tip, ref: MAIN })
  })

  it('switches back to the previous branch and refuses during a merge', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1\n' })
    repo.branch('other')
    const onMain = await headSnapshot(repo.dir)
    repo.checkout('other')
    const onOther = await headSnapshot(repo.dir)
    await applyUndoSteps(repo.dir, [{ type: 'checkout', expect: onOther, to: onMain }])
    expect(repo.git(['branch', '--show-current'])).toBe('main')

    repo.commit('ours', { 'a.txt': 'ours\n' })
    repo.checkout('other')
    repo.commit('theirs', { 'a.txt': 'theirs\n' })
    repo.checkout('main')
    try {
      repo.git(['merge', 'other'])
    } catch {
      /* conflict */
    }
    const now = await headSnapshot(repo.dir)
    await expect(applyUndoSteps(repo.dir, [{ type: 'reset', mode: 'keep', expect: now, to: onMain.sha! }])).rejects.toThrow(/merge is in progress/)
  })
})

describe('UndoJournal', () => {
  it('moves entries between undo and redo, clears redo on new actions and forgets stale history', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'a.txt': '1\n' })
    const journal = new UndoJournal()
    const record = async (msg: string) => {
      const before = await headSnapshot(repo.dir)
      repo.commit(msg, { 'a.txt': msg })
      const after = await headSnapshot(repo.dir)
      journal.record(repo.dir, {
        label: msg,
        undo: [{ type: 'reset', mode: 'soft', expect: after, to: before.sha! }],
        redo: [{ type: 'reset', mode: 'soft', expect: before, to: after.sha! }],
      })
    }
    await record('one')
    await record('two')
    expect(journal.state(repo.dir)).toEqual({ undo: 'two', redo: null })
    expect(await journal.undo(repo.dir)).toEqual({ label: 'two' })
    expect(journal.state(repo.dir)).toEqual({ undo: 'one', redo: 'two' })
    await journal.redo(repo.dir)
    expect(journal.state(repo.dir)).toEqual({ undo: 'two', redo: null })

    await journal.undo(repo.dir)
    repo.git(['commit', '-q', '-m', 'outside'])
    await expect(journal.redo(repo.dir)).rejects.toBeInstanceOf(StaleUndoError)
    expect(journal.state(repo.dir)).toEqual({ undo: null, redo: null })
    await expect(journal.undo(repo.dir)).rejects.toThrow('Nothing to undo.')
    expect(repo.rev('HEAD~2')).toBe(base)
  })
})

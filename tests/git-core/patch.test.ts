import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getFileDiff } from '@git-core/diff'
import { GitError } from '@git-core/errors'
import { applyHunks, buildPatch, quoteGitPath, type HunkSelection } from '@git-core/patch'
import type { DiffHunk } from '@shared/types'
import { cleanupFixtures, createFixtureRepo, makeMergeConflict, type FixtureRepo } from '../helpers/fixture'

afterEach(() => cleanupFixtures())

async function expectGitError(p: Promise<unknown>, code: string, message?: RegExp): Promise<GitError> {
  const err = await p.then(
    () => new Error('expected rejection'),
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).code).toBe(code)
  if (message) expect((err as GitError).message).toMatch(message)
  return err as GitError
}

/** Twenty numbered lines; changes near both ends produce two separate hunks. */
const BASE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

function lines(text: string): string[] {
  return text.split('\n')
}

function twoHunkRepo(path = 'f.txt'): { repo: FixtureRepo; modified: string } {
  const repo = createFixtureRepo()
  repo.commit('init', { [path]: BASE })
  const l = lines(BASE)
  l[1] = 'line 2 changed'
  l[17] = 'line 18 changed'
  const modified = l.join('\n')
  repo.write(path, modified)
  return { repo, modified }
}

const read = (repo: FixtureRepo, p: string): string => readFileSync(join(repo.dir, p), 'utf8')
/** Exact index content (FixtureRepo.git trims its output). */
function indexText(repo: FixtureRepo, p: string): string {
  return execGit(repo, ['cat-file', 'blob', `:0:${p}`])
}

function execGit(repo: FixtureRepo, args: string[]): string {
  return execFileSync('git', args, { cwd: repo.dir, encoding: 'utf8' })
}

function sel(h: DiffHunk, index: number, lineIdx?: number[]): HunkSelection {
  return { hunkIndex: index, header: h.header, ...(lineIdx ? { lines: lineIdx } : {}) }
}

describe('buildPatch', () => {
  const hunk: DiffHunk = {
    header: '@@ -1,3 +1,3 @@ fn',
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [
      { type: 'context', content: 'a', oldLine: 1, newLine: 1 },
      { type: 'del', content: 'b', oldLine: 2, newLine: null },
      { type: 'add', content: 'B', oldLine: null, newLine: 2 },
      { type: 'context', content: 'c', oldLine: 3, newLine: 3 },
    ],
  }

  it('emits whole hunks with headers and recomputed counts', () => {
    expect(buildPatch('x.txt', [hunk], [sel(hunk, 0)])).toBe(
      'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,3 +1,3 @@ fn\n a\n-b\n+B\n c\n',
    )
  })

  it('turns unselected - lines into context and drops unselected + lines', () => {
    expect(buildPatch('x.txt', [hunk], [sel(hunk, 0, [2])])).toContain('@@ -1,3 +1,4 @@ fn\n a\n b\n+B\n c\n')
    expect(buildPatch('x.txt', [hunk], [sel(hunk, 0, [1])])).toContain('@@ -1,3 +1,2 @@ fn\n a\n-b\n c\n')
  })

  it('swaps the roles for reverse patches', () => {
    // Reverse, only "-b" selected: "+B" stays (as context), "-b" is re-added on reversal.
    expect(buildPatch('x.txt', [hunk], [sel(hunk, 0, [1])], { reverse: true })).toContain(
      '@@ -1,4 +1,3 @@ fn\n a\n-b\n B\n c\n',
    )
    expect(buildPatch('x.txt', [hunk], [sel(hunk, 0, [2])], { reverse: true })).toContain(
      '@@ -1,2 +1,3 @@ fn\n a\n+B\n c\n',
    )
  })

  it('returns an empty patch when no change line is selected', () => {
    expect(buildPatch('x.txt', [hunk], [sel(hunk, 0, [0, 3])])).toBe('')
  })

  it('rejects stale or invalid selections', () => {
    expect(() => buildPatch('x.txt', [hunk], [{ hunkIndex: 0, header: '@@ -1 +1 @@' }])).toThrow(/refresh/)
    expect(() => buildPatch('x.txt', [hunk], [{ hunkIndex: 1, header: hunk.header }])).toThrow(/refresh/)
    expect(() => buildPatch('x.txt', [hunk], [sel(hunk, 0, [9])])).toThrow(GitError)
    expect(() => buildPatch('x.txt', [hunk], [sel(hunk, 0), sel(hunk, 0)])).toThrow(GitError)
  })

  it('quotes paths like git', () => {
    expect(quoteGitPath('a/plain-name_1.txt')).toBe('a/plain-name_1.txt')
    expect(quoteGitPath('a/with space')).toBe('"a/with space"')
    expect(quoteGitPath('a/é"\\\t')).toBe('"a/\\303\\251\\"\\\\\\t"')
  })
})

describe('applyHunks', () => {
  it('stages one hunk of a two-hunk change', async () => {
    const { repo, modified } = twoHunkRepo()
    const diff = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })
    expect(diff.hunks).toHaveLength(2)
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [sel(diff.hunks[1]!, 1)])

    const cached = execGit(repo, ['diff', '--cached'])
    expect(cached).toContain('+line 18 changed')
    expect(cached).not.toContain('line 2 changed')
    const expected = lines(BASE)
    expected[17] = 'line 18 changed'
    expect(indexText(repo, 'f.txt')).toBe(expected.join('\n'))
    expect(read(repo, 'f.txt')).toBe(modified) // worktree untouched
    const rest = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })
    expect(rest.hunks).toHaveLength(1)
    expect(rest.hunks[0]!.lines.some((l) => l.content === 'line 2 changed')).toBe(true)
  })

  it('stages a subset of lines with mixed additions and deletions', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'f.txt': 'a\nb\nc\nd\ne\n' })
    repo.write('f.txt', 'a\nB\nC\nd\nX\ne\n')
    const diff = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })
    expect(diff.hunks).toHaveLength(1)
    const h = diff.hunks[0]!
    const idx = (type: string, content: string): number => h.lines.findIndex((l) => l.type === type && l.content === content)
    // Take "-b", "+B" and "+X"; leave "-c" / "+C" unstaged.
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [
      sel(h, 0, [idx('del', 'b'), idx('add', 'B'), idx('add', 'X')]),
    ])
    expect(indexText(repo, 'f.txt')).toBe('a\nB\nc\nd\nX\ne\n')
    expect(read(repo, 'f.txt')).toBe('a\nB\nC\nd\nX\ne\n')
  })

  it('stages only a deletion line', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'f.txt': 'a\nb\nc\n' })
    repo.write('f.txt', 'a\nB\nc\n')
    const h = (await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })).hunks[0]!
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [sel(h, 0, [h.lines.findIndex((l) => l.type === 'del')])])
    expect(indexText(repo, 'f.txt')).toBe('a\nc\n')
  })

  it('unstages one hunk and a subset of lines', async () => {
    const { repo, modified } = twoHunkRepo()
    repo.git(['add', 'f.txt'])
    let diff = await getFileDiff(repo.dir, { kind: 'staged', path: 'f.txt' })
    expect(diff.hunks).toHaveLength(2)
    await applyHunks(repo.dir, 'f.txt', 'staged', 'unstage', [sel(diff.hunks[0]!, 0)])
    const expected = lines(BASE)
    expected[17] = 'line 18 changed'
    expect(indexText(repo, 'f.txt')).toBe(expected.join('\n'))
    expect(read(repo, 'f.txt')).toBe(modified)

    // Unstage only the "+" line of the remaining hunk; the "-" stays staged.
    diff = await getFileDiff(repo.dir, { kind: 'staged', path: 'f.txt' })
    const h = diff.hunks[0]!
    await applyHunks(repo.dir, 'f.txt', 'staged', 'unstage', [sel(h, 0, [h.lines.findIndex((l) => l.type === 'add')])])
    const expected2 = lines(BASE)
    expected2.splice(17, 1)
    expect(indexText(repo, 'f.txt')).toBe(expected2.join('\n'))
  })

  it('unstages only a deletion line (reverse with mixed lines)', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'f.txt': 'a\nb\nc\n' })
    repo.write('f.txt', 'a\nB\nc\n')
    repo.git(['add', 'f.txt'])
    const h = (await getFileDiff(repo.dir, { kind: 'staged', path: 'f.txt' })).hunks[0]!
    await applyHunks(repo.dir, 'f.txt', 'staged', 'unstage', [sel(h, 0, [h.lines.findIndex((l) => l.type === 'del')])])
    expect(indexText(repo, 'f.txt')).toBe('a\nb\nB\nc\n')
  })

  it('discards one hunk from the worktree and leaves the other and the index alone', async () => {
    const { repo } = twoHunkRepo()
    const diff = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'discard', [sel(diff.hunks[0]!, 0)])
    const expected = lines(BASE)
    expected[17] = 'line 18 changed'
    expect(read(repo, 'f.txt')).toBe(expected.join('\n'))
    expect(indexText(repo, 'f.txt')).toBe(BASE)
  })

  it('discards selected lines only', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'f.txt': 'a\nb\nc\n' })
    repo.write('f.txt', 'a\nB\nX\nc\n')
    const h = (await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })).hunks[0]!
    // Discard only "+X": the "-b"/"+B" change stays.
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'discard', [
      sel(h, 0, [h.lines.findIndex((l) => l.type === 'add' && l.content === 'X')]),
    ])
    expect(read(repo, 'f.txt')).toBe('a\nB\nc\n')
  })

  it('rejects a stale selection without touching the index', async () => {
    const { repo } = twoHunkRepo()
    const diff = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })
    repo.write('f.txt', 'new first line\n' + read(repo, 'f.txt'))
    await expectGitError(
      applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [sel(diff.hunks[0]!, 0)]),
      'INVALID_ARGUMENT',
      /refresh and try again/,
    )
    expect(indexText(repo, 'f.txt')).toBe(BASE)
    // Out-of-range hunk index is stale too.
    await expectGitError(
      applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [{ hunkIndex: 5, header: diff.hunks[0]!.header }]),
      'INVALID_ARGUMENT',
    )
  })

  it('handles files without a trailing newline', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'f.txt': 'a\nb\nlast' })
    repo.write('f.txt', 'a\nB\nlast changed')
    const h = (await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })).hunks[0]!
    expect(h.lines.some((l) => l.type === 'no-newline')).toBe(true)
    const idx = (type: string, content: string): number => h.lines.findIndex((l) => l.type === type && l.content === content)

    // Only the "+last changed" line: the old last line must gain a newline in between.
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [sel(h, 0, [idx('add', 'last changed')])])
    expect(indexText(repo, 'f.txt')).toBe('a\nb\nlast\nlast changed')

    repo.git(['reset', '-q'])
    // Only the "-last" line: the file then ends after "b\n".
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [sel(h, 0, [idx('del', 'last')])])
    expect(indexText(repo, 'f.txt')).toBe('a\nb\n')

    repo.git(['reset', '-q'])
    // Only the first change, away from the end of the file.
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [sel(h, 0, [idx('del', 'b'), idx('add', 'B')])])
    expect(indexText(repo, 'f.txt')).toBe('a\nB\nlast')

    repo.git(['reset', '-q'])
    await applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [sel(h, 0)])
    expect(indexText(repo, 'f.txt')).toBe('a\nB\nlast changed')
    expect(read(repo, 'f.txt')).toBe('a\nB\nlast changed')
  })

  it('unstages the "+" side of a no-newline change', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'f.txt': 'a\nlast' })
    repo.write('f.txt', 'a\nnew last')
    repo.git(['add', 'f.txt'])
    const h = (await getFileDiff(repo.dir, { kind: 'staged', path: 'f.txt' })).hunks[0]!
    // Unstage only "-last" (re-add it to the index), keeping "+new last".
    await applyHunks(repo.dir, 'f.txt', 'staged', 'unstage', [
      sel(h, 0, [h.lines.findIndex((l) => l.type === 'del' && l.content === 'last')]),
    ])
    expect(indexText(repo, 'f.txt')).toBe('a\nlast\nnew last')
  })

  it('works with paths containing spaces and unicode', async () => {
    for (const path of ['dir with space/my file.txt', 'ünïcödé/日本語 ファイル.txt', 'quote"back\\slash.txt']) {
      const { repo } = twoHunkRepo(path)
      const diff = await getFileDiff(repo.dir, { kind: 'unstaged', path })
      expect(diff.hunks).toHaveLength(2)
      await applyHunks(repo.dir, path, 'unstaged', 'stage', [sel(diff.hunks[0]!, 0)])
      const expected = lines(BASE)
      expected[1] = 'line 2 changed'
      expect(indexText(repo, path)).toBe(expected.join('\n'))
      const staged = await getFileDiff(repo.dir, { kind: 'staged', path })
      await applyHunks(repo.dir, path, 'staged', 'unstage', [sel(staged.hunks[0]!, 0)])
      expect(indexText(repo, path)).toBe(BASE)
    }
  })

  it('round-trips CRLF content', async () => {
    const repo = createFixtureRepo()
    const crlf = BASE.replace(/\n/g, '\r\n')
    repo.commit('init', { 'w.txt': crlf })
    const l = crlf.split('\r\n')
    l[1] = 'line 2 changed'
    l[17] = 'line 18 changed'
    const modified = l.join('\r\n')
    repo.write('w.txt', modified)
    const diff = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'w.txt' })
    await applyHunks(repo.dir, 'w.txt', 'unstaged', 'stage', [sel(diff.hunks[0]!, 0)])
    const expected = crlf.split('\r\n')
    expected[1] = 'line 2 changed'
    expect(indexText(repo, 'w.txt')).toBe(expected.join('\r\n'))
    // Discard the other hunk; the file keeps CRLF everywhere.
    const rest = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'w.txt' })
    await applyHunks(repo.dir, 'w.txt', 'unstaged', 'discard', [sel(rest.hunks[0]!, 0)])
    expect(read(repo, 'w.txt')).toBe(expected.join('\r\n'))
  })

  it('refuses new, deleted, binary, renamed and conflicted files', async () => {
    const repo = createFixtureRepo()
    repo.commit('init', { 'bin.dat': Buffer.from([0, 1, 2]), 'del.txt': 'x\n', 'old.txt': BASE })
    const any = (): HunkSelection[] => [{ hunkIndex: 0, header: '@@ -1 +1 @@' }]

    repo.write('new.txt', 'n\n')
    repo.git(['add', 'new.txt'])
    await expectGitError(applyHunks(repo.dir, 'new.txt', 'staged', 'unstage', any()), 'INVALID_ARGUMENT', /new file/)
    repo.write('intent.txt', 'i\n')
    repo.git(['add', '-N', 'intent.txt'])
    await expectGitError(applyHunks(repo.dir, 'intent.txt', 'unstaged', 'stage', any()), 'INVALID_ARGUMENT', /new file/)

    unlinkSync(join(repo.dir, 'del.txt'))
    await expectGitError(applyHunks(repo.dir, 'del.txt', 'unstaged', 'stage', any()), 'INVALID_ARGUMENT', /deleted/)

    repo.write('bin.dat', Buffer.from([0, 9, 9]))
    await expectGitError(applyHunks(repo.dir, 'bin.dat', 'unstaged', 'stage', any()), 'INVALID_ARGUMENT', /binary/)

    repo.git(['mv', 'old.txt', 'renamed.txt'])
    await expectGitError(
      applyHunks(repo.dir, 'renamed.txt', 'staged', 'unstage', any()),
      'INVALID_ARGUMENT',
      /new file|renamed/,
    )

    const repo2 = createFixtureRepo()
    const path = makeMergeConflict(repo2)
    await expectGitError(applyHunks(repo2.dir, path, 'unstaged', 'stage', any()), 'INVALID_ARGUMENT', /conflicted/)
  })

  it('rejects invalid source/action combinations and inputs', async () => {
    const { repo } = twoHunkRepo()
    const diff = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'f.txt' })
    const s = [sel(diff.hunks[0]!, 0)]
    await expectGitError(applyHunks(repo.dir, 'f.txt', 'staged', 'stage', s), 'INVALID_ARGUMENT')
    await expectGitError(applyHunks(repo.dir, 'f.txt', 'unstaged', 'unstage', s), 'INVALID_ARGUMENT')
    await expectGitError(applyHunks(repo.dir, 'f.txt', 'staged', 'discard', s), 'INVALID_ARGUMENT')
    await expectGitError(applyHunks(repo.dir, '../f.txt', 'unstaged', 'stage', s), 'INVALID_ARGUMENT')
    await expectGitError(applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', []), 'INVALID_ARGUMENT')
    await expectGitError(
      applyHunks(repo.dir, 'f.txt', 'unstaged', 'stage', [sel(diff.hunks[0]!, 0, [0])]),
      'INVALID_ARGUMENT',
      /No changes selected/,
    )
    expect(indexText(repo, 'f.txt')).toBe(BASE)
  })

  it('applies random line selections cleanly (stage, unstage, discard)', async () => {
    let seed = 12345
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const repo = createFixtureRepo()
    const make = (): string => {
      const out: string[] = []
      for (let i = 0; i < 12; i++) out.push(`l${rnd(6)}`)
      return out.join('\n') + (rnd(2) ? '\n' : '')
    }
    const pickLines = (h: DiffHunk): number[] => h.lines.map((_, i) => i).filter(() => rnd(2) === 0)
    const allSelections = async (kind: 'unstaged' | 'staged'): Promise<HunkSelection[]> =>
      (await getFileDiff(repo.dir, { kind, path: 'r.txt' })).hunks.map((h, i) => sel(h, i))

    repo.commit('init', { 'r.txt': make() })
    for (let round = 0; round < 25; round++) {
      const target = make()
      repo.write('r.txt', target)
      const diff = await getFileDiff(repo.dir, { kind: 'unstaged', path: 'r.txt' })
      if (diff.hunks.length === 0) continue
      const action = (['stage', 'unstage', 'discard'] as const)[round % 3]!
      if (action === 'unstage') repo.git(['add', 'r.txt'])
      const source = action === 'unstage' ? 'staged' : 'unstaged'
      const d = await getFileDiff(repo.dir, { kind: source, path: 'r.txt' })
      const selections = d.hunks.map((h, i) => sel(h, i, pickLines(h)))
      await applyHunks(repo.dir, 'r.txt', source, action, selections).catch((e: unknown) => {
        if (e instanceof GitError && /No changes selected/.test(e.message)) return
        throw e
      })
      // Applying the rest of the change must always work and converge.
      if (action === 'stage') {
        const rest = await allSelections('unstaged')
        if (rest.length) await applyHunks(repo.dir, 'r.txt', 'unstaged', 'stage', rest)
        expect(indexText(repo, 'r.txt')).toBe(target)
      } else if (action === 'unstage') {
        const rest = await allSelections('staged')
        if (rest.length) await applyHunks(repo.dir, 'r.txt', 'staged', 'unstage', rest)
        expect(indexText(repo, 'r.txt')).toBe(execGit(repo, ['cat-file', 'blob', 'HEAD:r.txt']))
        expect(read(repo, 'r.txt')).toBe(target)
      } else {
        const rest = await allSelections('unstaged')
        if (rest.length) await applyHunks(repo.dir, 'r.txt', 'unstaged', 'discard', rest)
        expect(read(repo, 'r.txt')).toBe(indexText(repo, 'r.txt'))
      }
      repo.commit(`round ${round}`, { 'r.txt': read(repo, 'r.txt') })
    }
  })
})

import { describe, expect, it } from 'vitest'
import type { CommitSummary } from '@shared/types'
import { addCoAuthor, applyType, currentType, recentCoAuthors, summaryHint, usesConventionalCommits } from '../../src/renderer/src/lib/commit-message'

const c = (authorName: string, authorEmail: string): CommitSummary => ({ sha: 'x', parents: [], authorName, authorEmail, authorTime: 0, committerName: '', committerEmail: '', commitTime: 0, subject: '' })

describe('commit message helpers', () => {
  it('detects Conventional Commits only when the history mostly uses them', () => {
    const conv = ['feat: a', 'fix(ui): b', 'chore!: c', 'docs: d', 'refactor: e', 'test: f', 'feat(api): g', 'Merge branch x', 'ci: h', 'perf: i', 'build: j', 'oops']
    expect(usesConventionalCommits(conv)).toBe(true)
    expect(usesConventionalCommits(['Add a', 'Fix b', 'Update c', 'Refactor d', 'feat: e', 'Tidy f', 'Bump g', 'Docs h', 'Test i', 'Merge j', 'More k'])).toBe(false)
    expect(usesConventionalCommits(['feat: a', 'fix: b'])).toBe(false) // too few to tell
  })

  it('sets or replaces the type, keeping scope and breaking marker', () => {
    expect(applyType('add login', 'feat')).toBe('feat: add login')
    expect(applyType('fix(auth)!: drop tokens', 'feat')).toBe('feat(auth)!: drop tokens')
    expect(applyType('chore: x', 'docs')).toBe('docs: x')
    expect(currentType('fix(ui): y')).toBe('fix')
    expect(currentType('Note: something')).toBeNull()
  })

  it('suggests recent co-authors, skipping me, duplicates and bots', () => {
    const commits = [c('Me', 'me@x.io'), c('Ann', 'ann@x.io'), c('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'), c('Ann Again', 'ANN@x.io'), c('Bo', 'bo@x.io')]
    expect(recentCoAuthors(commits, { name: 'Me', email: 'ME@x.io' })).toEqual([
      { name: 'Ann', email: 'ann@x.io' },
      { name: 'Bo', email: 'bo@x.io' },
    ])
  })

  it('appends Co-authored-by trailers once, after a blank line', () => {
    const ann = { name: 'Ann', email: 'ann@x.io' }
    const bo = { name: 'Bo', email: 'bo@x.io' }
    expect(addCoAuthor('', ann)).toBe('Co-authored-by: Ann <ann@x.io>')
    const one = addCoAuthor('Explain why.', ann)
    expect(one).toBe('Explain why.\n\nCo-authored-by: Ann <ann@x.io>')
    expect(addCoAuthor(one, bo)).toBe('Explain why.\n\nCo-authored-by: Ann <ann@x.io>\nCo-authored-by: Bo <bo@x.io>')
    expect(addCoAuthor(one, ann)).toBe(one)
  })

  it('hints about long summaries and trailing periods', () => {
    expect(summaryHint('Add login')).toBeNull()
    expect(summaryHint('x'.repeat(73))).toMatch(/cut off/)
    expect(summaryHint('Add login.')).toMatch(/period/)
    expect(summaryHint('Wait for it...')).toBeNull()
  })
})

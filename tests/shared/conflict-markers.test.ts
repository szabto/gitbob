import { describe, expect, it } from 'vitest'
import { hasConflictMarkers, parseConflicts, resolveConflicts, type ConflictSegment } from '@shared/conflict-markers'

const STANDARD = ['top\n', '<<<<<<< HEAD\n', 'ours 1\n', 'ours 2\n', '=======\n', 'theirs\n', '>>>>>>> feature\n', 'bottom\n'].join(
  '',
)

function conflicts(segs: ConflictSegment[]): Extract<ConflictSegment, { type: 'conflict' }>[] {
  return segs.filter((s): s is Extract<ConflictSegment, { type: 'conflict' }> => s.type === 'conflict')
}

describe('parseConflicts', () => {
  it('parses a standard conflict block', () => {
    const segs = parseConflicts(STANDARD)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ type: 'text', text: 'top\n' })
    expect(segs[2]).toEqual({ type: 'text', text: 'bottom\n' })
    const [c] = conflicts(segs)
    expect(c).toMatchObject({
      ours: 'ours 1\nours 2\n',
      base: null,
      theirs: 'theirs\n',
      oursLabel: 'HEAD',
      theirsLabel: 'feature',
    })
  })

  it('parses diff3 blocks with a base section', () => {
    const text = '<<<<<<< ours\nA\n||||||| base\nB\n=======\nC\n>>>>>>> theirs\n'
    const [c] = conflicts(parseConflicts(text))
    expect(c).toMatchObject({ ours: 'A\n', base: 'B\n', theirs: 'C\n', oursLabel: 'ours', theirsLabel: 'theirs' })
  })

  it('handles empty sides and unlabelled markers', () => {
    const [c] = conflicts(parseConflicts('<<<<<<<\n=======\nx\n>>>>>>>'))
    expect(c).toMatchObject({ ours: '', base: null, theirs: 'x\n', oursLabel: '', theirsLabel: '' })
  })

  it('handles an empty base section', () => {
    const [c] = conflicts(parseConflicts('<<<<<<< a\nX\n|||||||\n=======\nY\n>>>>>>> b\n'))
    expect(c!.base).toBe('')
  })

  it('preserves CRLF line endings exactly', () => {
    const text = 'a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> b\r\nz\r\n'
    const segs = parseConflicts(text)
    const [c] = conflicts(segs)
    expect(c).toMatchObject({ ours: 'ours\r\n', theirs: 'theirs\r\n', oursLabel: 'HEAD', theirsLabel: 'b' })
    expect(resolveConflicts(segs, [null])).toBe(text)
    expect(resolveConflicts(segs, ['theirs'])).toBe('a\r\ntheirs\r\nz\r\n')
  })

  it('parses several conflicts', () => {
    const text = `${STANDARD}middle\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\nend`
    const segs = parseConflicts(text)
    expect(conflicts(segs)).toHaveLength(2)
    expect(resolveConflicts(segs, ['ours', 'theirs'])).toBe('top\nours 1\nours 2\nbottom\nmiddle\ny\nend')
    expect(resolveConflicts(segs, [null, 'both'])).toBe(`${STANDARD}middle\nx\ny\nend`)
  })

  it('requires markers of exactly seven characters', () => {
    const text = '<<<<<<<< not a marker\n<<<<<<x\n=======\n>>>>>>>> nope\n'
    expect(conflicts(parseConflicts(text))).toHaveLength(0)
    expect(parseConflicts(text)).toEqual([{ type: 'text', text }])
    expect(hasConflictMarkers(text)).toBe(false)
  })

  it('requires a space before a label', () => {
    expect(conflicts(parseConflicts('<<<<<<<HEAD\na\n=======\nb\n>>>>>>> x\n'))).toHaveLength(0)
  })

  it('keeps unclosed or malformed blocks as plain text', () => {
    for (const text of [
      '<<<<<<< HEAD\nours\n=======\ntheirs\n',
      '<<<<<<< HEAD\nours\n>>>>>>> x\n',
      'x\n<<<<<<< HEAD\nonly ours',
    ]) {
      expect(parseConflicts(text)).toEqual([{ type: 'text', text }])
      expect(resolveConflicts(parseConflicts(text), [])).toBe(text)
    }
  })

  it('treats a stray start marker before a real block as text', () => {
    const text = '<<<<<<< stray\nfoo\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n'
    const segs = parseConflicts(text)
    expect(segs[0]).toEqual({ type: 'text', text: '<<<<<<< stray\nfoo\n' })
    expect(conflicts(segs)[0]).toMatchObject({ ours: 'a\n', theirs: 'b\n' })
    expect(resolveConflicts(segs, [null])).toBe(text)
  })

  it('keeps marker-looking content inside sides', () => {
    // A separator or base marker inside "theirs" is content, as is "=======" with a label.
    const text = '<<<<<<< HEAD\n======= x\n=======\n=======\n||||||| y\n>>>>>>> b\n'
    const [c] = conflicts(parseConflicts(text))
    expect(c).toMatchObject({ ours: '======= x\n', theirs: '=======\n||||||| y\n', base: null })
  })

  it('round-trips with all-null choices', () => {
    const samples = [
      STANDARD,
      '',
      'no conflicts here\n',
      '<<<<<<< a\r\nX\r\n||||||| b\r\nY\r\n=======\r\nZ\r\n>>>>>>> c',
      `${STANDARD}${STANDARD}<<<<<<< broken\n`,
    ]
    for (const s of samples) {
      const segs = parseConflicts(s)
      expect(resolveConflicts(segs, segs.map(() => null))).toBe(s)
      expect(resolveConflicts(segs, [])).toBe(s)
    }
  })

  it('resolves with base, and base of a two-way block is empty', () => {
    const segs = parseConflicts('<<<<<<< a\nX\n||||||| b\nY\n=======\nZ\n>>>>>>> c\n')
    expect(resolveConflicts(segs, ['base'])).toBe('Y\n')
    expect(resolveConflicts(parseConflicts(STANDARD), ['base'])).toBe('top\nbottom\n')
  })
})

describe('hasConflictMarkers', () => {
  it('detects start or end markers, even in broken blocks', () => {
    expect(hasConflictMarkers(STANDARD)).toBe(true)
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\n')).toBe(true)
    expect(hasConflictMarkers('a\n>>>>>>> theirs')).toBe(true)
    expect(hasConflictMarkers('a\r\n<<<<<<<\r\n')).toBe(true)
  })

  it('ignores ordinary text, including a lone separator', () => {
    expect(hasConflictMarkers('')).toBe(false)
    expect(hasConflictMarkers('Title\n=======\n')).toBe(false)
    expect(hasConflictMarkers('x <<<<<<< y\n')).toBe(false)
    expect(hasConflictMarkers(resolveConflicts(parseConflicts(STANDARD), ['both']))).toBe(false)
  })
})

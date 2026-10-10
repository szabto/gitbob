import { describe, expect, it } from 'vitest'
import { displayPath } from '../../src/renderer/src/lib/format'
import { formatAccelerator, normalizeAccelerator } from '../../src/renderer/src/lib/shortcuts'
import { fuzzyScore } from '../../src/renderer/src/lib/fuzzy'

describe('displayPath', () => {
  it.each([
    ['/Users/ann/code/app', '/Users/ann', '~/code/app'],
    ['/Users/ann', '/Users/ann/', '~'],
    ['/Users/anne/code', '/Users/ann', '/Users/anne/code'],
    ['/opt/repo', '/Users/ann', '/opt/repo'],
    ['C:\\\\Users\\\\ann\\\\repo', 'C:\\\\Users\\\\ann', '~\\\\repo'],
  ])('%s with home %s -> %s', (path, home, expected) => {
    expect(displayPath(path, home)).toBe(expected)
  })
})

describe('accelerators', () => {
  it('normalizes order and case', () => {
    expect(normalizeAccelerator('shift+mod+f')).toBe('Mod+Shift+F')
    expect(normalizeAccelerator('Alt+Mod+ArrowUp')).toBe('Mod+Alt+Up')
  })
  it('formats for display', () => {
    const f = formatAccelerator('Mod+Shift+F')
    expect(['⇧⌘F', 'Ctrl+Shift+F']).toContain(f)
  })
})

describe('fuzzyScore', () => {
  it('prefers substring matches and rejects non-matches', () => {
    expect(fuzzyScore('fetch', 'Repository Fetch')).toBeGreaterThan(fuzzyScore('fch', 'Repository Fetch'))
    expect(fuzzyScore('fch', 'Repository Fetch')).toBeGreaterThan(0)
    expect(fuzzyScore('zzz', 'Repository Fetch')).toBe(-1)
    expect(fuzzyScore('', 'anything')).toBe(0)
  })
})

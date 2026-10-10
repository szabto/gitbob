import { describe, expect, it } from 'vitest'
import { nativePath } from '@git-core/paths'

describe('nativePath', () => {
  it.each([
    ['C:/Users/ann/repo', 'C:\\Users\\ann\\repo'],
    ['d:/a b/c', 'd:\\a b\\c'],
    ['//server/share/repo', '\\\\server\\share\\repo'],
    ['/a b', '/a b'],
    ['relative/path', 'relative/path'],
  ])('win32: %s -> %s', (input, expected) => {
    expect(nativePath(input, 'win32')).toBe(expected)
  })
  it('is a no-op elsewhere', () => {
    expect(nativePath('C:/x\n', 'darwin')).toBe('C:/x')
    expect(nativePath('/home/ann/repo', 'linux')).toBe('/home/ann/repo')
  })
})

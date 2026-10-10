import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '@shared/channels'
import { ipcInputSchemas, shaSchema } from '@shared/ipc'

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown): boolean => schema.safeParse(v).success

describe('ipc input schemas', () => {
  it('declares a schema for every channel', () => {
    expect(Object.keys(ipcInputSchemas).sort()).toEqual([...IPC_CHANNELS].sort())
  })

  describe('paths (repo:open)', () => {
    const s = ipcInputSchemas['repo:open']
    it('accepts absolute paths', () => {
      expect(ok(s, { path: '/tmp/repo' })).toBe(true)
      expect(ok(s, { path: 'C:\\Users\\me\\repo' })).toBe(true)
    })
    it('rejects empty, too long, NUL-containing and non-string paths', () => {
      expect(ok(s, { path: '' })).toBe(false)
      expect(ok(s, { path: '/' + 'a'.repeat(4096) })).toBe(false)
      expect(ok(s, { path: '/' + 'a'.repeat(4095) })).toBe(true)
      expect(ok(s, { path: '/tmp/re\0po' })).toBe(false)
      expect(ok(s, { path: 42 })).toBe(false)
      expect(ok(s, {})).toBe(false)
      expect(ok(s, null)).toBe(false)
    })
    it('does not itself enforce absoluteness (openRepository does)', () => {
      expect(ok(s, { path: 'relative/path' })).toBe(true)
    })
  })

  describe('shaSchema', () => {
    it.each(['abcd', 'ABCDEF0123', 'a'.repeat(40), 'f'.repeat(64)])('accepts %s', (v) => {
      expect(ok(shaSchema, v)).toBe(true)
    })
    it.each(['--all', '-p', 'HEAD', 'HEAD~1', 'abc', 'zzzz', 'abcd^', 'abcd..ef01', 'abcd ', ' abcd', 'abcd\n', '', 'a'.repeat(65), 'main', 'abcd\0'])(
      'rejects %j',
      (v) => {
        expect(ok(shaSchema, v)).toBe(false)
      },
    )
    it('is used by commit:details', () => {
      const s = ipcInputSchemas['commit:details']
      expect(ok(s, { repoPath: '/r', sha: 'abcd1234' })).toBe(true)
      expect(ok(s, { repoPath: '/r', sha: '--output=/tmp/x' })).toBe(false)
    })
  })

  describe('log:page', () => {
    const s = ipcInputSchemas['log:page']
    const base = { repoPath: '/r', skip: 0, limit: 100 }
    it('accepts valid bounds', () => {
      expect(ok(s, base)).toBe(true)
      expect(ok(s, { ...base, limit: 1 })).toBe(true)
      expect(ok(s, { ...base, limit: 10_000 })).toBe(true)
      expect(ok(s, { ...base, skip: 10_000_000 })).toBe(true)
    })
    it.each([
      ['negative skip', { skip: -1 }],
      ['skip too large', { skip: 10_000_001 }],
      ['limit 0', { limit: 0 }],
      ['limit too large', { limit: 10_001 }],
      ['non-integer limit', { limit: 1.5 }],
      ['non-integer skip', { skip: 0.5 }],
      ['NaN limit', { limit: Number.NaN }],
      ['string limit', { limit: '10' }],
      ['NUL path', { repoPath: '/r\0' }],
    ])('rejects %s', (_name, patch) => {
      expect(ok(s, { ...base, ...patch })).toBe(false)
    })
  })

  describe('strict empty inputs', () => {
    it.each(['repo:pick', 'repo:recent'] as const)('%s accepts {} and rejects extra keys', (ch) => {
      expect(ok(ipcInputSchemas[ch], {})).toBe(true)
      expect(ok(ipcInputSchemas[ch], { path: '/x' })).toBe(false)
    })
  })

  it('repo:refs and repo:head require repoPath', () => {
    for (const ch of ['repo:refs', 'repo:head'] as const) {
      expect(ok(ipcInputSchemas[ch], { repoPath: '/r' })).toBe(true)
      expect(ok(ipcInputSchemas[ch], {})).toBe(false)
      expect(ok(ipcInputSchemas[ch], { repoPath: '/r\0x' })).toBe(false)
    }
  })
})

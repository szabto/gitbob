import { describe, expect, it } from 'vitest'
import type { RemoteInfo } from '@shared/types'
import { branchUrl, commitUrl } from '../../src/renderer/src/lib/web-links'

const r = (kind: NonNullable<RemoteInfo['hosted']>['kind'], webUrl: string): RemoteInfo => ({ name: 'origin', fetchUrl: '', pushUrl: '', hosted: { kind, owner: 'o', webUrl } })

describe('web links', () => {
  it('builds branch and commit URLs per service, encoding branch names', () => {
    expect(branchUrl(r('github', 'https://github.com/o/r'), 'feature/a b')).toBe('https://github.com/o/r/tree/feature/a%20b')
    expect(branchUrl(r('gitlab', 'https://gitlab.com/g/s/r'), 'x')).toBe('https://gitlab.com/g/s/r/-/tree/x')
    expect(branchUrl(r('bitbucket', 'https://bitbucket.org/w/r'), 'x')).toBe('https://bitbucket.org/w/r/src/x')
    expect(branchUrl(r('azure', 'https://dev.azure.com/o/p/_git/r'), 'f/x')).toBe('https://dev.azure.com/o/p/_git/r?version=GBf%2Fx')
    expect(commitUrl(r('github', 'https://github.com/o/r'), 'abc1234')).toBe('https://github.com/o/r/commit/abc1234')
    expect(commitUrl(r('gitlab', 'https://gitlab.com/g/r'), 'abc1234')).toBe('https://gitlab.com/g/r/-/commit/abc1234')
  })

  it('returns null for unknown remotes and bad shas', () => {
    expect(branchUrl({ name: 'o', fetchUrl: '/x', pushUrl: '/x' }, 'main')).toBeNull()
    expect(commitUrl(r('github', 'https://github.com/o/r'), 'zzz')).toBeNull()
  })
})

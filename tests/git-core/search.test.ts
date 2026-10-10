import { afterEach, describe, expect, it } from 'vitest'
import { searchCommits } from '@git-core/search'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

function repo() {
  const r = createFixtureRepo()
  const a = r.commit('Add login form', { 'a.txt': '1' })
  const b = r.commit('Fix crash in parser (regex: a.*b)', { 'a.txt': '2' })
  r.branch('side')
  r.checkout('side')
  r.git(['commit', '--allow-empty', '-q', '-m', 'Side work by someone else'], {
    GIT_AUTHOR_NAME: 'Zoë Example',
    GIT_AUTHOR_EMAIL: 'zoe@example.org',
  })
  const c = r.head()
  r.checkout('main')
  const d = r.commit('Improve LOGIN errors', { 'a.txt': '3' })
  return { r, a, b, c, d }
}

describe('searchCommits', () => {
  it('matches messages case-insensitively across all branches, newest first', async () => {
    const { r, a, d } = repo()
    expect((await searchCommits(r.dir, 'login')).shas).toEqual([d, a])
  })

  it('treats the query as literal text, not a regex', async () => {
    const { r, b } = repo()
    expect((await searchCommits(r.dir, 'a.*b')).shas).toEqual([b])
    expect((await searchCommits(r.dir, '^Fix')).shas).toEqual([])
  })

  it('matches author names and emails, including non-ASCII', async () => {
    const { r, c } = repo()
    expect((await searchCommits(r.dir, 'zoë')).shas).toEqual([c])
    expect((await searchCommits(r.dir, 'zoe@example')).shas).toEqual([c])
  })

  it('matches commit id prefixes', async () => {
    const { r, b } = repo()
    expect((await searchCommits(r.dir, b.slice(0, 8))).shas).toContain(b)
  })

  it('returns nothing for no matches and rejects invalid queries', async () => {
    const { r } = repo()
    expect(await searchCommits(r.dir, 'definitely-not-there')).toEqual({ shas: [], truncated: false })
    await expect(searchCommits(r.dir, '   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('option-like queries are searched literally', async () => {
    const { r } = repo()
    expect((await searchCommits(r.dir, '--all')).shas).toEqual([])
  })

  it('reports truncation', async () => {
    const { r } = repo()
    const res = await searchCommits(r.dir, 'test author', { limit: 2 })
    expect(res.shas).toHaveLength(2)
    expect(res.truncated).toBe(true)
  })
})

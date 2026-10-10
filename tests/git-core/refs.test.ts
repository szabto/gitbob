import { afterEach, describe, expect, it } from 'vitest'
import { classifyRef, getHead, listRefs, parseRefs } from '@git-core/refs'
import { cleanupFixtures, cloneFixtureRepo, createFixtureRepo } from '../helpers/fixture'

afterEach(() => {
  cleanupFixtures()
})

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('classifyRef', () => {
  it.each([
    ['refs/heads/main', 'head', 'main'],
    ['refs/heads/feature/x', 'head', 'feature/x'],
    ['refs/remotes/origin/main', 'remote', 'origin/main'],
    ['refs/tags/v1.0', 'tag', 'v1.0'],
    ['refs/stash', 'stash', 'stash'],
    ['refs/notes/commits', 'other', 'notes/commits'],
  ])('%s -> %s %s', (name, kind, shortName) => {
    expect(classifyRef(name)).toEqual({ kind, shortName })
  })
})

describe('parseRefs', () => {
  it('parses fields, peels tags, keeps upstream and skips symrefs', () => {
    const out = [
      ['refs/heads/main', A, '', 'refs/remotes/origin/main', '', 'ahead 2, behind 1'].join('\0'),
      ['refs/heads/old', A, '', 'refs/remotes/origin/old', '', 'gone'].join('\0'),
      ['refs/remotes/origin/HEAD', A, '', '', 'refs/remotes/origin/main'].join('\0'),
      ['refs/tags/v1', B, A, '', ''].join('\0'),
      '',
    ].join('\n')
    expect(parseRefs(out)).toEqual([
      {
        name: 'refs/heads/main',
        shortName: 'main',
        kind: 'head',
        target: A,
        upstream: 'refs/remotes/origin/main',
        ahead: 2,
        behind: 1,
      },
      {
        name: 'refs/heads/old',
        shortName: 'old',
        kind: 'head',
        target: A,
        upstream: 'refs/remotes/origin/old',
        ahead: 0,
        behind: 0,
        upstreamGone: true,
      },
      { name: 'refs/tags/v1', shortName: 'v1', kind: 'tag', target: A },
    ])
  })

  it('returns [] for empty output', () => {
    expect(parseRefs('')).toEqual([])
    expect(parseRefs('\n\n')).toEqual([])
  })
})

describe('listRefs', () => {
  it('returns [] for an empty repository', async () => {
    const repo = createFixtureRepo()
    expect(await listRefs(repo.dir)).toEqual([])
  })

  it('lists local branches with their targets', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('one')
    repo.branch('feature')
    repo.branch('nested/topic')
    const c2 = repo.commit('two')
    const refs = await listRefs(repo.dir)
    const heads = refs.filter((r) => r.kind === 'head')
    expect(heads.map((r) => [r.shortName, r.target]).sort()).toEqual(
      [
        ['feature', c1],
        ['main', c2],
        ['nested/topic', c1],
      ].sort(),
    )
    expect(heads.every((r) => r.upstream === undefined)).toBe(true)
  })

  it('lists remote-tracking refs, skips origin/HEAD and reports upstream', async () => {
    const source = createFixtureRepo()
    const c1 = source.commit('one')
    source.branch('dev')
    const c2 = source.commit('two')
    const clone = cloneFixtureRepo(source)
    // Sanity: the clone really has a symbolic origin/HEAD.
    expect(clone.git(['symbolic-ref', 'refs/remotes/origin/HEAD'])).toBe('refs/remotes/origin/main')

    const refs = await listRefs(clone.dir)
    const remotes = refs.filter((r) => r.kind === 'remote')
    expect(remotes.map((r) => [r.shortName, r.target]).sort()).toEqual(
      [
        ['origin/dev', c1],
        ['origin/main', c2],
      ].sort(),
    )
    expect(refs.find((r) => r.name === 'refs/remotes/origin/HEAD')).toBeUndefined()
    const main = refs.find((r) => r.name === 'refs/heads/main')
    expect(main).toMatchObject({ kind: 'head', target: c2, upstream: 'refs/remotes/origin/main' })
    expect(remotes.every((r) => r.upstream === undefined)).toBe(true)
  })

  it('peels annotated tags to the commit and keeps lightweight tags', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('one')
    const c2 = repo.commit('two')
    repo.tag('light', { target: c1 })
    repo.tag('v1.0', { annotated: true, target: c1 })
    repo.tag('v2.0', { annotated: true })
    const tagObject = repo.rev('refs/tags/v1.0')
    expect(tagObject).not.toBe(c1) // really an annotated tag object

    const tags = (await listRefs(repo.dir)).filter((r) => r.kind === 'tag')
    expect(Object.fromEntries(tags.map((t) => [t.shortName, t.target]))).toEqual({
      light: c1,
      'v1.0': c1,
      'v2.0': c2,
    })
  })

  it('lists the stash ref', async () => {
    const repo = createFixtureRepo()
    repo.commit('one', { 'a.txt': 'original\n' })
    repo.write('a.txt', 'changed\n')
    repo.git(['stash', 'push', '-q', '-m', 'wip'])
    const stashSha = repo.rev('refs/stash')
    const stash = (await listRefs(repo.dir)).filter((r) => r.kind === 'stash')
    expect(stash).toEqual([{ name: 'refs/stash', shortName: 'stash', kind: 'stash', target: stashSha }])
  })
})

describe('getHead', () => {
  it('reports an attached HEAD', async () => {
    const repo = createFixtureRepo()
    const sha = repo.commit('one')
    expect(await getHead(repo.dir)).toEqual({ sha, ref: 'refs/heads/main', detached: false, unborn: false })
  })

  it('reports a detached HEAD', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('one')
    repo.commit('two')
    repo.checkout(c1)
    expect(await getHead(repo.dir)).toEqual({ sha: c1, ref: null, detached: true, unborn: false })
  })

  it('reports an unborn HEAD in a fresh repository', async () => {
    const repo = createFixtureRepo({ initialBranch: 'trunk' })
    expect(await getHead(repo.dir)).toEqual({ sha: null, ref: 'refs/heads/trunk', detached: false, unborn: true })
  })

  it('reports an unborn orphan branch in a repository with history', async () => {
    const repo = createFixtureRepo()
    repo.commit('one')
    repo.git(['checkout', '-q', '--orphan', 'orphan'])
    expect(await getHead(repo.dir)).toEqual({ sha: null, ref: 'refs/heads/orphan', detached: false, unborn: true })
  })
})

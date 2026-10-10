import { afterEach, describe, expect, it } from 'vitest'
import { clearLogCache, getCommitPage, LOG_FORMAT, parseLog } from '@git-core/log'
import { runGit } from '@git-core/runner'
import type { CommitSummary } from '@shared/types'
import { cleanupFixtures, cloneFixtureRepo, createFixtureRepo } from '../helpers/fixture'

afterEach(() => {
  clearLogCache()
  cleanupFixtures()
})

/** Load every page with the given size, like the renderer's infinite query. */
async function pagedLog(dir: string, limit: number): Promise<CommitSummary[]> {
  const out: CommitSummary[] = []
  for (;;) {
    const page = await getCommitPage(dir, { skip: out.length, limit })
    out.push(...page.commits)
    if (!page.hasMore) return out
    expect(page.commits).toHaveLength(limit)
  }
}

/** One `git log --date-order` run over the same revisions (the pre-cache implementation). */
async function gitLogAll(dir: string): Promise<CommitSummary[]> {
  const { stdout } = await runGit(
    ['log', '-z', '--date-order', `--format=${LOG_FORMAT}`, '--branches', '--remotes', '--tags', 'HEAD', '--'],
    { cwd: dir },
  )
  return parseLog(stdout)
}

/** A history with merges, several roots, skewed dates, tags and unmerged branches. */
function buildTangledRepo(): ReturnType<typeof createFixtureRepo> {
  const repo = createFixtureRepo()
  repo.commit('root')
  for (let i = 0; i < 6; i++) {
    repo.branch(`f${i}`)
    repo.checkout(`f${i}`)
    repo.commit(`f${i} a`)
    if (i % 2) repo.commit(`f${i} b`)
    repo.checkout('main')
    repo.commit(`main ${i}`)
    if (i % 3 !== 2) repo.merge(`f${i}`)
  }
  // Second and third roots, one merged into main, one only reachable from a tag.
  repo.git(['checkout', '-q', '--orphan', 'other'])
  repo.git(['rm', '-rq', '--cached', '--ignore-unmatch', '.'])
  repo.commit('other root')
  repo.commit('other 2')
  repo.checkout('main')
  repo.git(['merge', '-q', '--no-ff', '--allow-unrelated-histories', '-m', 'merge other', 'other'])
  repo.git(['checkout', '-q', '--orphan', 'lonely'])
  repo.commit('lonely root')
  repo.tag('lonely-tag')
  repo.checkout('main')
  repo.git(['branch', '-D', 'lonely'])
  // Out-of-order committer dates.
  repo.git(['commit', '--allow-empty', '-q', '-m', 'old-dated'], {
    GIT_AUTHOR_DATE: '1000000000 +0000',
    GIT_COMMITTER_DATE: '1000000000 +0000',
  })
  repo.commit('after old')
  repo.tag('v1', { annotated: true })
  return repo
}

async function fullLog(dir: string): Promise<CommitSummary[]> {
  const page = await getCommitPage(dir, { skip: 0, limit: 10_000 })
  expect(page.hasMore).toBe(false)
  return page.commits
}

function assertTopological(commits: CommitSummary[]): void {
  const index = new Map(commits.map((c, i) => [c.sha, i]))
  for (const [i, c] of commits.entries()) {
    for (const p of c.parents) {
      const pi = index.get(p)
      if (pi !== undefined) expect(pi, `parent ${p} of ${c.sha} must come after it`).toBeGreaterThan(i)
    }
  }
}

describe('parseLog', () => {
  it('returns [] for empty output', () => {
    expect(parseLog('')).toEqual([])
  })

  it('parses a record', () => {
    const rec = ['a'.repeat(40), `${'b'.repeat(40)} ${'c'.repeat(40)}`, 'N', 'n@x', '10', 'C', 'c@x', '20', 'subj'].join('\0')
    expect(parseLog(rec)).toEqual([
      {
        sha: 'a'.repeat(40),
        parents: ['b'.repeat(40), 'c'.repeat(40)],
        authorName: 'N',
        authorEmail: 'n@x',
        authorTime: 10,
        committerName: 'C',
        committerEmail: 'c@x',
        commitTime: 20,
        subject: 'subj',
      },
    ])
  })

  it('throws on malformed output', () => {
    expect(() => parseLog('abc\0def\0ghi')).toThrow(/Malformed/)
  })

  it('round-trips real git output', async () => {
    const repo = createFixtureRepo()
    repo.commit('one')
    repo.commit('two')
    const { stdout } = await runGit(['log', '-z', `--format=${LOG_FORMAT}`], { cwd: repo.dir })
    expect(parseLog(stdout).map((c) => c.subject)).toEqual(['two', 'one'])
  })
})

describe('getCommitPage', () => {
  it('returns [] for an empty repository', async () => {
    const repo = createFixtureRepo()
    expect(await getCommitPage(repo.dir, { skip: 0, limit: 50 })).toEqual({ commits: [], hasMore: false })
  })

  it('returns linear history newest first with correct fields', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('first')
    const c2 = repo.commit('second')
    const c3 = repo.commit('third')
    const commits = await fullLog(repo.dir)
    expect(commits.map((c) => c.sha)).toEqual([c3, c2, c1])
    expect(commits.map((c) => c.parents)).toEqual([[c2], [c1], []])
    const [top] = commits
    expect(top).toMatchObject({
      subject: 'third',
      authorName: 'Test Author',
      authorEmail: 'author@example.com',
      committerName: 'Test Committer',
      committerEmail: 'committer@example.com',
    })
    expect(top!.authorTime).toBe(Number(repo.git(['log', '-1', '--format=%at', c3])))
    expect(top!.commitTime).toBe(Number(repo.git(['log', '-1', '--format=%ct', c3])))
    expect(commits[0]!.commitTime).toBeGreaterThan(commits[1]!.commitTime)
  })

  it('reports merge commits with two parents', async () => {
    const repo = createFixtureRepo()
    repo.commit('base')
    repo.branch('feature')
    const m1 = repo.commit('main work')
    repo.checkout('feature')
    const f1 = repo.commit('feature work')
    repo.checkout('main')
    const merge = repo.merge('feature')
    const commits = await fullLog(repo.dir)
    const mc = commits.find((c) => c.sha === merge)!
    expect(mc.parents).toEqual([m1, f1])
    expect(commits[0]!.sha).toBe(merge)
    assertTopological(commits)
  })

  it('includes commits on other branches, tags and remotes', async () => {
    const source = createFixtureRepo()
    const base = source.commit('base')
    source.branch('remote-only')
    source.checkout('remote-only')
    const remoteOnly = source.commit('remote only')
    source.checkout('main')
    const clone = cloneFixtureRepo(source)

    clone.branch('side')
    clone.checkout('side')
    const side = clone.commit('side only')
    clone.checkout('main')
    // A commit reachable only through a tag.
    clone.checkout(base)
    const tagged = clone.commit('tag only')
    clone.tag('only-tag')
    clone.checkout('main')

    const shas = (await fullLog(clone.dir)).map((c) => c.sha)
    expect(new Set(shas)).toEqual(new Set([base, remoteOnly, side, tagged]))
    expect(shas).toHaveLength(4)
  })

  it('includes a detached HEAD commit not referenced by any ref', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('one')
    repo.checkout(c1)
    const detached = repo.commit('detached')
    const shas = (await fullLog(repo.dir)).map((c) => c.sha)
    expect(shas).toEqual([detached, c1])
  })

  it('paginates without gaps or duplicates', async () => {
    const repo = createFixtureRepo()
    repo.commit('c0')
    repo.branch('b')
    for (let i = 1; i <= 12; i++) {
      if (i % 3 === 0) repo.checkout('b')
      repo.commit(`c${i}`)
      repo.checkout('main')
    }
    repo.merge('b')
    const all = await fullLog(repo.dir)
    expect(all).toHaveLength(14)

    const pages: CommitSummary[] = []
    let skip = 0
    let hasMore = true
    while (hasMore) {
      const page = await getCommitPage(repo.dir, { skip, limit: 5 })
      expect(page.commits.length).toBeLessThanOrEqual(5)
      pages.push(...page.commits)
      hasMore = page.hasMore
      skip += page.commits.length
      if (hasMore) expect(page.commits).toHaveLength(5)
    }
    expect(pages.map((c) => c.sha)).toEqual(all.map((c) => c.sha))
    expect(new Set(pages.map((c) => c.sha)).size).toBe(pages.length)

    const exact = await getCommitPage(repo.dir, { skip: 0, limit: 14 })
    expect(exact.hasMore).toBe(false)
    expect(exact.commits).toHaveLength(14)
    const minus = await getCommitPage(repo.dir, { skip: 0, limit: 13 })
    expect(minus.hasMore).toBe(true)
    const past = await getCommitPage(repo.dir, { skip: 100, limit: 5 })
    expect(past).toEqual({ commits: [], hasMore: false })
  })

  it('returns other branches when an orphan branch with no commits is checked out', async () => {
    const repo = createFixtureRepo()
    const c1 = repo.commit('one')
    const c2 = repo.commit('two')
    repo.git(['checkout', '-q', '--orphan', 'empty'])
    const page = await getCommitPage(repo.dir, { skip: 0, limit: 50 })
    expect(page.commits.map((c) => c.sha)).toEqual([c2, c1])
  })

  it('round-trips unicode, emoji, tabs and quotes in subjects and names', async () => {
    const repo = createFixtureRepo()
    const subjects = ['Árvíztűrő tükörfúrógép', 'emoji 🚀✨ 👩‍💻', 'tab\there', `quotes "double" 'single' \`back\``, '中文 日本語 한국어']
    for (const s of subjects) repo.commit(s)
    repo.git(['commit', '--allow-empty', '-q', '-m', 'author'], {
      GIT_AUTHOR_NAME: 'Zoë Ñandú 🙂',
      GIT_AUTHOR_EMAIL: 'zoë@exämple.com',
      GIT_AUTHOR_DATE: '1800000000 +0000',
      GIT_COMMITTER_DATE: '1800000000 +0000',
    })
    const commits = await fullLog(repo.dir)
    expect(commits[0]).toMatchObject({ authorName: 'Zoë Ñandú 🙂', authorEmail: 'zoë@exämple.com' })
    expect(commits.slice(1).map((c) => c.subject)).toEqual([...subjects].reverse())
  })

  it('keeps only the first line of a multi-line message as the subject', async () => {
    const repo = createFixtureRepo()
    repo.commit('subject line\n\nbody line 1\nbody line 2')
    const [c] = await fullLog(repo.dir)
    expect(c!.subject).toBe('subject line')
  })

  it('orders children before parents across branches', async () => {
    const repo = createFixtureRepo()
    repo.commit('root')
    repo.branch('a')
    repo.branch('b')
    repo.commit('m1')
    repo.checkout('a')
    repo.commit('a1')
    repo.checkout('b')
    repo.commit('b1')
    repo.checkout('a')
    repo.commit('a2')
    repo.checkout('main')
    repo.commit('m2')
    repo.merge('a')
    repo.checkout('b')
    repo.commit('b2')
    repo.merge('main')
    // Out-of-order committer dates must still be emitted topologically.
    repo.git(['commit', '--allow-empty', '-q', '-m', 'old-dated'], {
      GIT_AUTHOR_DATE: '1000000000 +0000',
      GIT_COMMITTER_DATE: '1000000000 +0000',
    })
    repo.commit('after old')
    const commits = await fullLog(repo.dir)
    expect(commits).toHaveLength(11)
    assertTopological(commits)
  })

  it('honours an AbortSignal', async () => {
    const repo = createFixtureRepo()
    repo.commit('one')
    const ac = new AbortController()
    ac.abort()
    await expect(getCommitPage(repo.dir, { skip: 0, limit: 10, signal: ac.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    })
  })

  it('page-by-page loading equals one full git log run (merges, multiple roots, skewed dates)', async () => {
    const repo = buildTangledRepo()
    const reference = await gitLogAll(repo.dir)
    expect(reference.length).toBeGreaterThan(25)
    expect(reference.filter((c) => c.parents.length === 0)).toHaveLength(3)
    expect(reference.filter((c) => c.parents.length > 1).length).toBeGreaterThanOrEqual(5)
    for (const limit of [1, 2, 3, 7, reference.length - 1, reference.length, reference.length + 5]) {
      clearLogCache()
      expect(await pagedLog(repo.dir, limit), `limit ${limit}`).toEqual(reference)
    }
    // Arbitrary windows (not page-aligned) also match.
    for (const [skip, limit] of [
      [5, 4],
      [11, 9],
      [reference.length - 2, 10],
    ] as const) {
      const page = await getCommitPage(repo.dir, { skip, limit })
      expect(page.commits).toEqual(reference.slice(skip, skip + limit))
      expect(page.hasMore).toBe(skip + limit < reference.length)
    }
  })

  it('sees new commits and moved refs on later pages (cache invalidation)', async () => {
    const repo = buildTangledRepo()
    await pagedLog(repo.dir, 4) // warm the cache
    const extra = repo.commit('new on main')
    let all = await pagedLog(repo.dir, 4)
    expect(all).toEqual(await gitLogAll(repo.dir))
    expect(all[0]!.sha).toBe(extra)

    // Deleting a branch drops its unmerged commits from later pages.
    repo.git(['branch', '-D', 'f2'])
    all = await pagedLog(repo.dir, 4)
    expect(all).toEqual(await gitLogAll(repo.dir))
    expect(all.some((c) => c.subject === 'f2 a')).toBe(false)

    // Detached HEAD on a commit no ref points at.
    repo.checkout('main~1')
    const detached = repo.commit('detached')
    all = await pagedLog(repo.dir, 4)
    expect(all).toEqual(await gitLogAll(repo.dir))
    expect(all.map((c) => c.sha)).toContain(detached)
  })

  it('invalidates when a replace ref changes parents', async () => {
    const repo = createFixtureRepo()
    for (let i = 0; i < 6; i++) repo.commit(`c${i}`)
    const before = await pagedLog(repo.dir, 2)
    expect(before).toHaveLength(6)
    // Make c3 a root via a replacement object: c0..c2 disappear from the walk.
    const c3 = repo.rev('HEAD~2')
    repo.git(['replace', '--graft', c3])
    const after = await pagedLog(repo.dir, 2)
    expect(after).toEqual(await gitLogAll(repo.dir))
    expect(after).toHaveLength(3)
  })

  it('invalidates when a shallow clone is deepened', async () => {
    const source = createFixtureRepo()
    for (let i = 0; i < 8; i++) source.commit(`c${i}`)
    const clone = cloneFixtureRepo(source)
    // Re-clone shallowly through file:// (local clones ignore --depth).
    clone.git(['fetch', '-q', '--depth=2', `file://${source.dir}`, 'main'])
    clone.git(['reset', '-q', '--hard', 'FETCH_HEAD'])
    clone.git(['update-ref', '-d', 'refs/remotes/origin/main'])
    clone.git(['reflog', 'expire', '--expire=now', '--all'])
    clone.git(['gc', '-q', '--prune=now'])
    const shallow = await pagedLog(clone.dir, 1)
    expect(shallow).toHaveLength(2)
    clone.git(['fetch', '-q', '--deepen=3', `file://${source.dir}`, 'main'])
    const deeper = await pagedLog(clone.dir, 1)
    expect(deeper).toEqual(await gitLogAll(clone.dir))
    expect(deeper).toHaveLength(5)
  })

  it('honours an AbortSignal on later pages', async () => {
    const repo = createFixtureRepo()
    for (let i = 0; i < 5; i++) repo.commit(`c${i}`)
    const ac = new AbortController()
    ac.abort()
    await expect(getCommitPage(repo.dir, { skip: 2, limit: 2, signal: ac.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    })
    expect((await getCommitPage(repo.dir, { skip: 2, limit: 2 })).commits.map((c) => c.subject)).toEqual(['c2', 'c1'])
  })
})

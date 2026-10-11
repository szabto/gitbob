import { afterEach, describe, expect, it } from 'vitest'
import { clearLogCache, countCommits, getCommitPage, LOG_FORMAT, parseLog } from '@git-core/log'
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

describe('getCommitPage with a filter', () => {
  type Filter = NonNullable<Parameters<typeof getCommitPage>[1]['filter']>

  /** One plain `git log` with the equivalent arguments: the reference every filtered paging must equal. */
  async function gitLogFiltered(dir: string, revs: string[], extra: string[], path?: string): Promise<CommitSummary[]> {
    const { stdout } = await runGit(
      ['log', '-z', '--date-order', '--parents', `--format=${LOG_FORMAT}`, ...extra, ...revs, '--', ...(path ? [path] : [])],
      { cwd: dir, env: { GIT_LITERAL_PATHSPECS: '1' } },
    )
    return parseLog(stdout)
  }

  async function pagedFiltered(dir: string, filter: Filter, limit: number): Promise<CommitSummary[]> {
    const out: CommitSummary[] = []
    for (;;) {
      const page = await getCommitPage(dir, { skip: out.length, limit, filter })
      out.push(...page.commits)
      if (!page.hasMore) return out
      expect(page.commits).toHaveLength(limit)
    }
  }

  let clock = 1_750_000_000
  function commitAs(repo: ReturnType<typeof createFixtureRepo>, msg: string, name: string, email: string, files: Record<string, string> = {}): string {
    for (const [p, c] of Object.entries(files)) repo.write(p, c)
    if (Object.keys(files).length) repo.git(['add', '-A'])
    clock += 60
    const t = `${clock} +0000`
    repo.git(['commit', '--allow-empty', '-q', '-m', msg], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: t,
      GIT_COMMITTER_DATE: t,
    })
    return repo.head()
  }

  /** main and two feature branches with a few authors and paths; returns subject->sha. */
  function buildFilterRepo() {
    const repo = createFixtureRepo()
    const s: Record<string, string> = {}
    s.root = commitAs(repo, 'root', 'Alice Smith', 'alice@example.com', { 'README.md': 'r\n', 'src/a.ts': '1\n' })
    repo.branch('feat')
    repo.branch('docs')
    s.m1 = commitAs(repo, 'm1', 'Bob (a.k.a. B*b)', 'bob@corp.test', { 'src/m.ts': '2\n' })
    s.m2 = commitAs(repo, 'm2', 'alice smith', 'ALICE@example.com', { 'other.txt': 'o\n' })
    repo.checkout('feat')
    s.f1 = commitAs(repo, 'f1', 'Carol', 'carol@example.com', { 'src/b.ts': 'b\n' })
    s.f2 = commitAs(repo, 'f2', 'Alice Smith', 'alice@example.com', { 'src/a.ts': 'f\n' })
    repo.checkout('docs')
    s.d1 = commitAs(repo, 'd1', 'Dan', 'dan@example.com', { 'docs/x.md': 'x\n' })
    repo.tag('docs-tag')
    s.d2 = commitAs(repo, 'd2', 'Dan', 'dan@example.com', { 'docs/y.md': 'y\n' })
    repo.checkout('main')
    clock += 60
    repo.git(['merge', '--no-ff', '-q', '-m', 'merge feat', 'feat'], {
      GIT_AUTHOR_DATE: `${clock} +0000`,
      GIT_COMMITTER_DATE: `${clock} +0000`,
    })
    s.merge = repo.head()
    s.m3 = commitAs(repo, 'm3', 'Bob (a.k.a. B*b)', 'bob@corp.test', { 'README.md': 'r2\n' })
    return { repo, s }
  }

  const subjects = (cs: CommitSummary[]): string[] => cs.map((c) => c.subject)

  it('restricts to one branch, several branches or a tag', async () => {
    const { repo } = buildFilterRepo()
    const docs = await pagedFiltered(repo.dir, { refs: ['refs/heads/docs'] }, 50)
    expect(subjects(docs)).toEqual(['d2', 'd1', 'root'])
    const feat = await pagedFiltered(repo.dir, { refs: ['refs/heads/feat'] }, 50)
    expect(subjects(feat)).toEqual(['f2', 'f1', 'root'])
    const both = await pagedFiltered(repo.dir, { refs: ['refs/heads/feat', 'refs/heads/docs'] }, 50)
    expect(both).toEqual(await gitLogFiltered(repo.dir, ['refs/heads/feat', 'refs/heads/docs'], []))
    expect(new Set(subjects(both))).toEqual(new Set(['d2', 'd1', 'f2', 'f1', 'root']))
    const tag = await pagedFiltered(repo.dir, { refs: ['refs/tags/docs-tag'] }, 50)
    expect(subjects(tag)).toEqual(['d1', 'root'])
    assertTopological(both)
  })

  it('works with remote-tracking refs', async () => {
    const { repo } = buildFilterRepo()
    const clone = cloneFixtureRepo(repo)
    const page = await getCommitPage(clone.dir, { skip: 0, limit: 50, filter: { refs: ['refs/remotes/origin/docs'] } })
    expect(subjects(page.commits)).toEqual(['d2', 'd1', 'root'])
  })

  it('filters by author name or email, case-insensitively and literally', async () => {
    const { repo } = buildFilterRepo()
    const alice = await pagedFiltered(repo.dir, { author: 'ALICE smith' }, 50)
    expect(subjects(alice)).toEqual(['f2', 'm2', 'root'])
    expect(subjects(await pagedFiltered(repo.dir, { author: 'Alice@Example' }, 50))).toEqual(['f2', 'm2', 'root'])
    // Regex metacharacters are taken literally.
    expect(subjects(await pagedFiltered(repo.dir, { author: '(a.k.a. b*b)' }, 50))).toEqual(['m3', 'm1'])
    expect(await pagedFiltered(repo.dir, { author: 'a.ice' }, 50)).toEqual([])
    expect(await pagedFiltered(repo.dir, { author: '.*' }, 50)).toEqual([])
    expect(await pagedFiltered(repo.dir, { author: '[' }, 50)).toEqual([])
    expect(subjects(await pagedFiltered(repo.dir, { author: 'corp.test' }, 50))).toEqual(['m3', 'm1'])
  })

  it('filters by path with rewritten parents that keep the graph connected', async () => {
    const { repo, s } = buildFilterRepo()
    const a = await pagedFiltered(repo.dir, { path: 'src/a.ts' }, 50)
    expect(subjects(a)).toEqual(['f2', 'root'])
    expect(a).toEqual(await gitLogFiltered(repo.dir, ['--branches', '--remotes', '--tags', 'HEAD'], [], 'src/a.ts'))
    // Parents are rewritten to the nearest commit in the filtered history (f2's real parent is f1).
    expect(repo.rev(`${s.f2}^`)).toBe(s.f1)
    expect(a.find((c) => c.subject === 'f2')!.parents).toEqual([s.root])
    // src/ changed on both sides, so the merge is kept, with both (rewritten) parents.
    const src = await pagedFiltered(repo.dir, { path: 'src' }, 50)
    expect(subjects(src)).toEqual(['merge feat', 'f2', 'f1', 'm1', 'root'])
    expect(src[0]!.parents).toEqual([s.m1, s.f2])
    expect(src.find((c) => c.subject === 'm1')!.parents).toEqual([s.root])
    // src/a.ts only changed on feat: the merge is TREESAME to that parent and simplified away.
    expect(a.some((c) => c.sha === s.merge)).toBe(false)
    const ids = new Set(a.map((c) => c.sha))
    for (const c of a) for (const p of c.parents) expect(ids.has(p), `parent ${p} of ${c.subject}`).toBe(true)
    assertTopological(a)

    // A directory and the root-level README.
    expect(subjects(await pagedFiltered(repo.dir, { path: 'docs' }, 50))).toEqual(['d2', 'd1'])
    expect(subjects(await pagedFiltered(repo.dir, { path: 'README.md' }, 50))).toEqual(['m3', 'root'])
    // Paths are literal: glob characters do not match.
    expect(await pagedFiltered(repo.dir, { path: 'src/*.ts' }, 50)).toEqual([])
  })

  it('does not follow renames (history before the rename is not included)', async () => {
    const repo = createFixtureRepo()
    repo.commit('add old', { 'old.txt': 'content that is long enough to be a rename\n' })
    repo.git(['mv', 'old.txt', 'new.txt'])
    repo.commit('rename')
    repo.commit('edit new', { 'new.txt': 'content that is long enough to be a rename\nmore\n' })
    const page = await getCommitPage(repo.dir, { skip: 0, limit: 50, filter: { path: 'new.txt' } })
    expect(subjects(page.commits)).toEqual(['edit new', 'rename'])
    // The rename commit becomes a root of the filtered graph.
    expect(page.commits[1]!.parents).toEqual([])
  })

  it('combines refs, author and path filters (AND)', async () => {
    const { repo } = buildFilterRepo()
    const filter: Filter = { refs: ['refs/heads/feat', 'refs/heads/docs'], author: 'alice', path: 'src' }
    const got = await pagedFiltered(repo.dir, filter, 50)
    expect(subjects(got)).toEqual(['f2', 'root'])
    expect(got).toEqual(
      await gitLogFiltered(repo.dir, ['refs/heads/feat', 'refs/heads/docs'], ['-F', '-i', '--author=alice'], 'src'),
    )
    expect(subjects(await pagedFiltered(repo.dir, { refs: ['refs/heads/main'], author: 'bob' }, 50))).toEqual(['m3', 'm1'])
  })

  it('pages filtered history equal to one full filtered git log for any page size', async () => {
    const repo = buildTangledRepo()
    for (let i = 0; i < 6; i++) commitAs(repo, `alice ${i}`, 'Alice', 'alice@x.test', { [`p/${i % 2}.txt`]: `${i}\n` })
    const cases: { filter: Filter; revs: string[]; extra: string[]; path?: string }[] = [
      { filter: { refs: ['refs/heads/main', 'refs/tags/lonely-tag'] }, revs: ['refs/heads/main', 'refs/tags/lonely-tag'], extra: [] },
      { filter: { author: 'test author' }, revs: ['--branches', '--remotes', '--tags', 'HEAD'], extra: ['-F', '-i', '--author=test author'] },
      { filter: { path: 'p/0.txt' }, revs: ['--branches', '--remotes', '--tags', 'HEAD'], extra: [], path: 'p/0.txt' },
    ]
    for (const { filter, revs, extra, path } of cases) {
      const reference = await gitLogFiltered(repo.dir, revs, extra, path)
      expect(reference.length).toBeGreaterThan(2)
      for (const limit of [1, 2, 3, 7, reference.length - 1, reference.length, reference.length + 5]) {
        expect(await pagedFiltered(repo.dir, filter, limit), `${JSON.stringify(filter)} limit ${limit}`).toEqual(reference)
      }
      const exact = await getCommitPage(repo.dir, { skip: 0, limit: reference.length, filter })
      expect(exact.hasMore).toBe(false)
      const past = await getCommitPage(repo.dir, { skip: reference.length + 3, limit: 5, filter })
      expect(past).toEqual({ commits: [], hasMore: false })
    }
  })

  it('treats an empty filter like no filter', async () => {
    const repo = buildTangledRepo()
    const reference = await gitLogAll(repo.dir)
    const page = await getCommitPage(repo.dir, { skip: 0, limit: 10_000, filter: { refs: [], author: '', path: '' } })
    expect(page.commits).toEqual(reference)
    expect((await getCommitPage(repo.dir, { skip: 3, limit: 4, filter: {} })).commits).toEqual(reference.slice(3, 7))
  })

  it('filters by author/path in a repository whose HEAD is unborn', async () => {
    const repo = createFixtureRepo()
    expect(await getCommitPage(repo.dir, { skip: 0, limit: 10, filter: { author: 'x' } })).toEqual({ commits: [], hasMore: false })
    repo.commit('one', { 'a.txt': '1' })
    repo.git(['checkout', '-q', '--orphan', 'empty'])
    const page = await getCommitPage(repo.dir, { skip: 0, limit: 10, filter: { path: 'a.txt' } })
    expect(subjects(page.commits)).toEqual(['one'])
  })

  it('rejects invalid filters', async () => {
    const { repo } = buildFilterRepo()
    const bad: Filter[] = [
      { refs: ['main'] },
      { refs: ['HEAD'] },
      { refs: ['refs/heads/nope'] },
      { refs: ['refs/notes/commits'] },
      { refs: ['refs/heads/main', 'refs/heads/missing'] },
      { refs: ['refs/heads/main~1'] },
      { refs: ['refs/heads/main@{1}'] },
      { refs: ['refs/heads/a..b'] },
      { refs: ['--all'] },
      { refs: ['refs/heads/main\0x'] },
      { author: 'x'.repeat(201) },
      { author: 'a\0b' },
      { path: '../outside' },
      { path: '/etc/passwd' },
      { path: 'a\0b' },
    ]
    for (const filter of bad) {
      await expect(getCommitPage(repo.dir, { skip: 0, limit: 10, filter }), JSON.stringify(filter)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    }
  })
})

describe('hidden branches', () => {
  it('leaves out commits reachable only from hidden refs, keeping shared history and HEAD', async () => {
    const repo = createFixtureRepo()
    const base = repo.commit('base', { 'a.txt': '1' })
    repo.branch('side')
    repo.checkout('side')
    const side = repo.commit('side only', { 's.txt': 's' })
    repo.tag('v-side')
    repo.checkout('main')
    const main = repo.commit('main work', { 'm.txt': 'm' })
    const all = await getCommitPage(repo.dir, { skip: 0, limit: 100 })
    expect(all.commits.map((c) => c.sha)).toContain(side)
    const hidden = await getCommitPage(repo.dir, { skip: 0, limit: 100, hidden: ['refs/heads/side', 'refs/tags/v-side'] })
    expect(hidden.commits.map((c) => c.sha)).toEqual([main, base])
    // Paging uses the cached walk; a different hidden set must not reuse it.
    const page2 = await getCommitPage(repo.dir, { skip: 1, limit: 1, hidden: ['refs/heads/side', 'refs/tags/v-side'] })
    expect(page2.commits.map((c) => c.sha)).toEqual([base])
    const page2all = await getCommitPage(repo.dir, { skip: 1, limit: 1 })
    expect(page2all.commits).toHaveLength(1)
    // Hiding the checked-out branch keeps it visible through HEAD; malformed entries are ignored.
    const headHidden = await getCommitPage(repo.dir, { skip: 0, limit: 100, hidden: ['refs/heads/main', 'refs/heads/*', '--all'] })
    expect(headHidden.commits.map((c) => c.sha)).toEqual(expect.arrayContaining([main, side, base]))
  })
})

describe('countCommits', () => {
  it('counts what the graph shows, excluding hidden refs', async () => {
    const repo = createFixtureRepo()
    repo.commit('base', { 'a.txt': '1' })
    repo.branch('side')
    repo.checkout('side')
    repo.commit('s1', { 's.txt': '1' })
    repo.commit('s2', { 's.txt': '2' })
    repo.checkout('main')
    repo.commit('m1', { 'm.txt': '1' })
    expect(await countCommits(repo.dir)).toBe(4)
    expect(await countCommits(repo.dir, ['refs/heads/side'])).toBe(2)
    expect(await countCommits(createFixtureRepo().dir)).toBe(0)
  })
})

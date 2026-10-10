import { afterEach, describe, expect, it } from 'vitest'
import { assertValidTagName, createTag, deleteRemoteTag, deleteTag, listTags, pushTag } from '@git-core/tags'
import { cleanupFixtures, cloneFixtureRepo, createFixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

function repoWithHistory() {
  const repo = createFixtureRepo()
  const a = repo.commit('a', { 'f.txt': 'a\n' })
  const b = repo.commit('b', { 'f.txt': 'b\n' })
  return { repo, a, b }
}

describe('listTags', () => {
  it('returns [] for an empty repository', async () => {
    expect(await listTags(createFixtureRepo().dir)).toEqual([])
  })

  it('lists lightweight and annotated tags newest first, peeled to commits', async () => {
    const { repo, a, b } = repoWithHistory()
    repo.tag('v1', { target: a })
    repo.tag('v2', { annotated: true, target: b })

    const tags = await listTags(repo.dir)
    expect(tags.map((t) => t.name)).toEqual(['v2', 'v1'])
    expect(tags[0]).toMatchObject({ name: 'v2', target: b, annotated: true, message: 'Tag v2', taggerName: 'Test Committer' })
    expect(tags[0]?.time).toEqual(expect.any(Number))
    expect(tags[1]).toEqual({ name: 'v1', target: a, annotated: false, message: '', taggerName: null, time: null })
  })

  it('fully peels a tag of a tag', async () => {
    const { repo, b } = repoWithHistory()
    repo.tag('inner', { annotated: true, target: b })
    repo.git(['-c', 'advice.nestedTag=false', 'tag', '-a', '-m', 'outer', 'outer', 'inner'])
    const outer = (await listTags(repo.dir)).find((t) => t.name === 'outer')
    expect(outer).toMatchObject({ target: b, annotated: true })
  })
})

describe('createTag / deleteTag', () => {
  it('creates a lightweight tag', async () => {
    const { repo, a } = repoWithHistory()
    await createTag(repo.dir, 'release/1.0', a)
    expect(repo.git(['cat-file', '-t', 'refs/tags/release/1.0'])).toBe('commit')
    expect(repo.rev('release/1.0')).toBe(a)
  })

  it('creates an annotated tag with a multi-line message from stdin', async () => {
    const { repo, b } = repoWithHistory()
    const message = '-n first line\n\nbody with `quotes` and $(not a shell)\n'
    await createTag(repo.dir, 'v2.0', b.slice(0, 10), { message })
    expect(repo.git(['cat-file', '-t', 'refs/tags/v2.0'])).toBe('tag')
    const tag = (await listTags(repo.dir))[0]
    expect(tag).toMatchObject({ name: 'v2.0', target: b, annotated: true, message: message.trim() })
  })

  it('treats a blank message as a lightweight tag', async () => {
    const { repo, a } = repoWithHistory()
    await createTag(repo.dir, 'light', a, { message: '   ' })
    expect(repo.git(['cat-file', '-t', 'refs/tags/light'])).toBe('commit')
  })

  it('refuses duplicates, invalid names and invalid targets', async () => {
    const { repo, a, b } = repoWithHistory()
    await createTag(repo.dir, 'v1', a)
    await expect(createTag(repo.dir, 'v1', b)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(repo.rev('v1')).toBe(a)
    await expect(createTag(repo.dir, 'x', 'HEAD')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(createTag(repo.dir, 'x', '--all')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(createTag(repo.dir, 'x', 'deadbeefdeadbeef')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it.each(['', '-f', '--delete', 'a..b', 'a b', 'x.lock', 'a~1', 'a^', 'a:b', '@{-1}', 'x/', 'a\0b'])(
    'rejects tag name %j',
    async (name) => {
      const { repo } = repoWithHistory()
      await expect(assertValidTagName(repo.dir, name)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    },
  )

  it('deletes a tag and reports missing ones', async () => {
    const { repo, a } = repoWithHistory()
    repo.tag('v1', { target: a })
    await deleteTag(repo.dir, 'v1')
    expect(await listTags(repo.dir)).toEqual([])
    await expect(deleteTag(repo.dir, 'v1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(deleteTag(repo.dir, '-d')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('pushTag / deleteRemoteTag', () => {
  function setup() {
    const seed = createFixtureRepo()
    seed.commit('seed', { 'f.txt': '1\n' })
    const server = createFixtureRepo({ bare: true })
    seed.git(['push', '-q', server.dir, 'main'])
    return { server, clone: cloneFixtureRepo(server) }
  }

  it('pushes a tag and deletes it on the remote', async () => {
    const { server, clone } = setup()
    await createTag(clone.dir, 'v1', clone.head(), { message: 'release' })
    await pushTag(clone.dir, 'origin', 'v1')
    expect(server.git(['rev-parse', 'v1^{}'])).toBe(clone.head())
    expect(server.git(['cat-file', '-t', 'v1'])).toBe('tag')

    await deleteRemoteTag(clone.dir, 'origin', 'v1')
    expect(server.git(['tag', '--list'])).toBe('')
    // The local tag stays.
    expect((await listTags(clone.dir)).map((t) => t.name)).toEqual(['v1'])
    // Git treats deleting a tag the remote no longer has as a no-op.
    await expect(deleteRemoteTag(clone.dir, 'origin', 'v1')).resolves.toBeUndefined()
  })

  it('never moves an existing remote tag', async () => {
    const { server, clone } = setup()
    const first = clone.head()
    clone.git(['tag', 'v1'])
    clone.git(['push', '-q', 'origin', 'v1'])
    const second = clone.commit('next', { 'f.txt': '2\n' })
    clone.git(['tag', '-d', 'v1'])
    clone.git(['tag', 'v1', second])
    await expect(pushTag(clone.dir, 'origin', 'v1')).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringContaining('already has a different tag'),
    })
    expect(server.git(['rev-parse', 'v1'])).toBe(first)
  })

  it('validates remote and tag names', async () => {
    const { clone } = setup()
    clone.git(['tag', 'v1'])
    await expect(pushTag(clone.dir, '--mirror', 'v1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(pushTag(clone.dir, '../x', 'v1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(pushTag(clone.dir, 'origin', '--all')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(pushTag(clone.dir, 'origin', 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(deleteRemoteTag(clone.dir, 'origin', 'a:b')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

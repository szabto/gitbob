import { nativePath } from '@git-core/paths'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { AskpassServer } from '@git-core/askpass'
import { assertValidCloneUrl, cloneRepository, initRepository, repoNameFromUrl, sanitizeFolderName } from '@git-core/create'
import { openRepository } from '@git-core/repository'
import { runGit } from '@git-core/runner'
import { cleanupFixtures, createFixtureRepo, createSeededBareRepo, makeTempDir } from '../helpers/fixture'
import { startHttpGitServer } from '../helpers/http-git-server'

afterEach(cleanupFixtures)

const posixOnly = process.platform === 'win32' ? it.skip : it

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runGit(args, { cwd })).stdout.trim()
}

describe('repoNameFromUrl', () => {
  it.each([
    ['https://github.com/a/b.git', 'b'],
    ['https://github.com/a/b', 'b'],
    ['https://github.com/a/b/', 'b'],
    ['git@host:a/b', 'b'],
    ['git@host:b.git', 'b'],
    ['/path/to/repo.git/', 'repo'],
    ['/path/to/repo/.git', 'repo'],
    ['C:\\work\\proj.git', 'proj'],
    ['ssh://host:22/x/y.git', 'y'],
    ['git://example.org/some%20thing', 'some%20thing'],
    ['file:///tmp/My Repo', 'My Repo'],
    ['https://host/a/..', 'repository'],
    ['https://host/a/.', 'repository'],
    ['https://host/', 'host'],
    ['', 'repository'],
    ['https://host/a/con', 'con_'],
    ['https://host/a/na<me>?.git', 'name'],
  ])('%s -> %s', (url, name) => {
    expect(repoNameFromUrl(url)).toBe(name)
  })

  it('sanitizes folder names', () => {
    expect(sanitizeFolderName('a/b')).toBe('ab')
    expect(sanitizeFolderName('trailing. . ')).toBe('trailing')
    expect(sanitizeFolderName('..')).toBe('repository')
    expect(sanitizeFolderName('x\u0001y')).toBe('xy')
    expect(Buffer.byteLength(sanitizeFolderName('é'.repeat(300)))).toBeLessThanOrEqual(200)
  })
})

describe('assertValidCloneUrl', () => {
  it.each([
    'https://github.com/a/b.git',
    'http://127.0.0.1:8080/x',
    'ssh://git@host:22/x/y.git',
    'ssh://[::1]/x',
    'git://example.org/x',
    'file:///tmp/x',
    'git@github.com:a/b.git',
    'user@[::1]:repo',
    '/abs/path/repo',
  ])('accepts %s', (url) => {
    expect(() => assertValidCloneUrl(url)).not.toThrow()
  })

  it.each([
    '',
    '-uploadpack=touch x',
    '--upload-pack=x',
    'ext::sh -c touch% x',
    'ext::sh',
    'EXT::sh',
    'fd::3',
    'testgit::/x',
    'https://host/a b',
    'https://host/a\nb',
    'https://host/a\0b',
    'https://host/\tx',
    'ssh://-oProxyCommand=touch/x',
    'ssh://user@-oProxyCommand=x/y',
    'git@-oProxyCommand=x:y',
    'ftp://host/x',
    'relative/path',
    './repo',
    'host:path',
    'https://',
  ])('rejects %j', (url) => {
    expect(() => assertValidCloneUrl(url)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })
})

describe('cloneRepository', () => {
  it('clones a local bare repository by path', async () => {
    const { bare, seed } = createSeededBareRepo()
    const parent = makeTempDir()
    const { path } = await cloneRepository(bare.dir, parent, {})
    expect(path).toBe(join(parent, basename(bare.dir)))
    expect((await openRepository(path)).root).toBe(path)
    expect(await git(path, ['rev-parse', 'HEAD'])).toBe(seed.head())
    expect(await git(path, ['rev-parse', 'origin/feature'])).toBe(seed.rev('feature'))
    expect(readdirSync(path).sort()).toEqual(['.git', 'f0.txt', 'f1.txt', 'f2.txt'])
  })

  it('uses a custom folder name and honours --depth over file://', async () => {
    const { bare } = createSeededBareRepo(5)
    const parent = makeTempDir()
    const progress: { phase: string; percent: number }[] = []
    const { path } = await cloneRepository(`file://${bare.dir}`, parent, {
      name: 'shallow copy',
      depth: 2,
      onProgress: (p) => progress.push(p),
    })
    expect(path).toBe(join(parent, 'shallow copy'))
    expect(await git(path, ['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(await git(path, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    expect(progress.length).toBeGreaterThan(0)
    for (const p of progress) {
      expect(p.percent).toBeGreaterThanOrEqual(0)
      expect(p.percent).toBeLessThanOrEqual(100)
    }
  })

  it('clones into an existing empty folder', async () => {
    const { bare } = createSeededBareRepo(1)
    const parent = makeTempDir()
    mkdirSync(join(parent, 'dest'))
    const { path } = await cloneRepository(bare.dir, parent, { name: 'dest' })
    expect(existsSync(join(path, 'f0.txt'))).toBe(true)
  })

  it('refuses a non-empty destination or a file in the way, without touching it', async () => {
    const { bare } = createSeededBareRepo(1)
    const parent = makeTempDir()
    mkdirSync(join(parent, 'dest'))
    writeFileSync(join(parent, 'dest', 'mine.txt'), 'keep me')
    await expect(cloneRepository(bare.dir, parent, { name: 'dest' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/already exists/),
    })
    expect(readdirSync(join(parent, 'dest'))).toEqual(['mine.txt'])
    writeFileSync(join(parent, 'file'), 'x')
    await expect(cloneRepository(bare.dir, parent, { name: 'file' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('validates name, depth and parent folder', async () => {
    const { bare } = createSeededBareRepo(1)
    const parent = makeTempDir()
    for (const name of ['a/b', '..', '.', '', 'x:y', 'con']) {
      await expect(cloneRepository(bare.dir, parent, { name }), name).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    for (const depth of [0, -1, 1.5, Number.NaN]) {
      await expect(cloneRepository(bare.dir, parent, { depth })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(cloneRepository(bare.dir, 'relative', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(cloneRepository(bare.dir, join(parent, 'missing'), {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(readdirSync(parent)).toEqual([])
  })

  it('never runs ext:: commands', async () => {
    const parent = makeTempDir()
    for (const url of ['ext::sh -c touch% pwned', 'ext::sh%20-c%20touch%20pwned']) {
      await expect(cloneRepository(url, parent, { name: 'x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(readdirSync(parent)).toEqual([])
  })

  it('removes the partial folder when the clone fails', async () => {
    const parent = makeTempDir()
    const missing = join(makeTempDir(), 'nope.git')
    await expect(cloneRepository(missing, parent, {})).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(readdirSync(parent)).toEqual([])
  })

  it('keeps a pre-existing empty destination folder when the clone fails', async () => {
    const parent = makeTempDir()
    mkdirSync(join(parent, 'dest'))
    await expect(cloneRepository(join(makeTempDir(), 'nope.git'), parent, { name: 'dest' })).rejects.toMatchObject({
      code: 'GIT_FAILED',
    })
    expect(existsSync(join(parent, 'dest'))).toBe(true)
  })

  it('rejects immediately with an already-aborted signal', async () => {
    const { bare } = createSeededBareRepo(1)
    const parent = makeTempDir()
    const ac = new AbortController()
    ac.abort()
    await expect(cloneRepository(bare.dir, parent, { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(readdirSync(parent)).toEqual([])
  })

  posixOnly('clones over authenticated HTTP through the askpass bridge', async () => {
    const { bare, seed } = createSeededBareRepo()
    const server = await startHttpGitServer({ projectRoot: dirname(bare.dir), username: 'alice', password: 'pw 123' })
    const askpass = new AskpassServer(async (p) => (p.secret ? 'pw 123' : 'alice'))
    await askpass.start()
    try {
      const parent = makeTempDir()
      const progress: number[] = []
      const url = `${server.url}/${basename(bare.dir)}`
      const { path } = await cloneRepository(url, parent, { env: askpass.env(), onProgress: (p) => progress.push(p.percent) })
      expect(path).toBe(join(parent, basename(bare.dir)))
      expect(await git(path, ['rev-parse', 'HEAD'])).toBe(seed.head())
      expect(await git(path, ['remote', 'get-url', 'origin'])).toBe(url)
      expect(progress.length).toBeGreaterThan(0)
    } finally {
      await askpass.stop()
      await server.close()
    }
  })

  posixOnly('maps a refused credential prompt to an authentication error and cleans up', async () => {
    const { bare } = createSeededBareRepo(1)
    const server = await startHttpGitServer({ projectRoot: dirname(bare.dir), username: 'alice', password: 'pw' })
    const askpass = new AskpassServer(async () => null)
    await askpass.start()
    try {
      const parent = makeTempDir()
      await expect(
        cloneRepository(`${server.url}/${basename(bare.dir)}`, parent, { env: askpass.env() }),
      ).rejects.toThrow(/Authentication failed/)
      expect(readdirSync(parent)).toEqual([])
    } finally {
      await askpass.stop()
      await server.close()
    }
  })

  posixOnly('cancelling mid-clone removes the partially created folder', async () => {
    const { bare } = createSeededBareRepo(1)
    const server = await startHttpGitServer({ projectRoot: dirname(bare.dir), username: 'alice', password: 'pw' })
    const ac = new AbortController()
    const parent = makeTempDir()
    const target = join(parent, basename(bare.dir))
    let sawTarget = false
    // Hold the credential prompt open: git has already created the destination by then.
    const askpass = new AskpassServer(async () => {
      sawTarget = existsSync(target)
      ac.abort()
      return new Promise<string | null>(() => {})
    })
    await askpass.start()
    try {
      await expect(
        cloneRepository(`${server.url}/${basename(bare.dir)}`, parent, { env: askpass.env(), signal: ac.signal }),
      ).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(sawTarget).toBe(true)
      expect(readdirSync(parent)).toEqual([])
    } finally {
      await askpass.stop()
      await server.close()
    }
  })
})

describe('initRepository', () => {
  it('initialises a new folder (creating missing parents) with an initial branch', async () => {
    const dir = join(makeTempDir(), 'deep', 'new repo')
    await initRepository(dir, { initialBranch: 'trunk' })
    expect((await openRepository(dir)).root).toBe(dir)
    expect(await git(dir, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/trunk')
  })

  it('initialises an existing folder with files, without changing them', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'keep.txt'), 'x')
    await initRepository(dir, {})
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(await git(dir, ['status', '--porcelain'])).toBe('?? keep.txt')
  })

  it('allows a repository nested inside another work tree', async () => {
    const outer = createFixtureRepo()
    const dir = join(outer.dir, 'inner')
    await initRepository(dir, { initialBranch: 'main' })
    expect(nativePath(await git(dir, ['rev-parse', '--show-toplevel']))).toBe(dir)
  })

  it('refuses a folder that is already a repository', async () => {
    const repo = createFixtureRepo()
    await expect(initRepository(repo.dir, {})).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/already a Git repository/),
    })
    // A .git file (worktree/submodule link) counts too.
    const dir = makeTempDir()
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n')
    await expect(initRepository(dir, {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('validates the path and branch name', async () => {
    const base = makeTempDir()
    await expect(initRepository('relative/x', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    for (const initialBranch of ['', '-x', 'a..b', 'with space', '@{-1}', 'x.lock']) {
      await expect(initRepository(join(base, 'r'), { initialBranch }), initialBranch).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    }
    expect(readdirSync(base)).toEqual([])
    writeFileSync(join(base, 'file'), 'x')
    await expect(initRepository(join(base, 'file'), {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

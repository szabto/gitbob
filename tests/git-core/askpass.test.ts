import { afterEach, describe, expect, it } from 'vitest'
import { dirname, basename } from 'node:path'
import { AskpassServer, isSecretPrompt, parseProgress, type AskpassPrompt } from '@git-core/askpass'
import { fetch, push } from '@git-core/remotes'
import { listRefs } from '@git-core/refs'
import { cleanupFixtures, createFixtureRepo } from '../helpers/fixture'
import { startHttpGitServer } from '../helpers/http-git-server'

afterEach(cleanupFixtures)

const posixOnly = process.platform === 'win32' ? it.skip : it

async function setup() {
  const seed = createFixtureRepo()
  seed.commit('seed', { 'f.txt': '1\n' })
  const bare = createFixtureRepo({ bare: true })
  seed.git(['push', '-q', bare.dir, 'main'])
  const server = await startHttpGitServer({ projectRoot: dirname(bare.dir), username: 'alice', password: 's3cret pass' })
  const work = createFixtureRepo()
  work.git(['remote', 'add', 'origin', `${server.url}/${basename(bare.dir)}`])
  return { seed, bare, server, work }
}

describe('askpass helpers', () => {
  it('classifies prompts', () => {
    expect(isSecretPrompt("Username for 'https://example.com': ")).toBe(false)
    expect(isSecretPrompt("Password for 'https://alice@example.com': ")).toBe(true)
    expect(isSecretPrompt("Enter passphrase for key '/home/a/.ssh/id_ed25519': ")).toBe(true)
  })

  it('parses git progress output', () => {
    expect(parseProgress('Receiving objects:  45% (45/100)\rReceiving objects:  60% (60/100)')).toEqual({
      phase: 'Receiving objects',
      percent: 60,
    })
    expect(parseProgress('remote: Counting objects: 100% (3/3), done.\n')).toEqual({ phase: 'Counting objects', percent: 100 })
    expect(parseProgress('From http://x\n * [new branch] main -> origin/main\n')).toBeNull()
  })
})

describe('AskpassServer against a real authenticated HTTP remote', () => {
  posixOnly('answers username and password prompts so fetch and push succeed', async () => {
    const { server, work, bare } = await setup()
    const prompts: AskpassPrompt[] = []
    const askpass = new AskpassServer(async (p) => {
      prompts.push(p)
      return p.secret ? 's3cret pass' : 'alice'
    })
    await askpass.start()
    try {
      await fetch(work.dir, { remote: 'origin', prune: false, env: askpass.env() })
      expect((await listRefs(work.dir)).map((r) => r.name)).toContain('refs/remotes/origin/main')
      expect(prompts.map((p) => p.secret)).toEqual([false, true])
      expect(prompts[0]!.prompt).toMatch(/^Username for 'http:\/\/127\.0\.0\.1:\d+'/)

      work.git(['switch', '-q', '-c', 'topic', 'origin/main'])
      work.commit('topic', { 't.txt': 't' })
      const progress: number[] = []
      await push(work.dir, {
        branch: 'topic',
        remote: 'origin',
        setUpstream: true,
        force: 'none',
        env: askpass.env(),
        onProgress: (p) => progress.push(p.percent),
      })
      expect(bare.git(['rev-parse', 'topic'])).toBe(work.head())
    } finally {
      await askpass.stop()
      await server.close()
    }
  })

  posixOnly('a cancelled prompt fails the operation with an authentication error', async () => {
    const { server, work } = await setup()
    const askpass = new AskpassServer(async () => null)
    await askpass.start()
    try {
      await expect(fetch(work.dir, { remote: 'origin', prune: false, env: askpass.env() })).rejects.toThrow(
        /Authentication failed/,
      )
    } finally {
      await askpass.stop()
      await server.close()
    }
  })

  posixOnly('wrong credentials are rejected', async () => {
    const { server, work } = await setup()
    const askpass = new AskpassServer(async (p) => (p.secret ? 'wrong' : 'alice'))
    await askpass.start()
    try {
      await expect(fetch(work.dir, { remote: 'origin', prune: false, env: askpass.env() })).rejects.toMatchObject({
        code: 'GIT_FAILED',
      })
      expect(server.authAttempts()).toBeGreaterThan(0)
    } finally {
      await askpass.stop()
      await server.close()
    }
  })

  posixOnly('rejects connections without the session token', async () => {
    const askpass = new AskpassServer(async () => 'leaked')
    await askpass.start()
    try {
      const env = askpass.env()
      const net = await import('node:net')
      const reply = await new Promise<string>((resolve) => {
        const sock = net.connect(env.GITBOB_ASKPASS_SOCKET!)
        let buf = ''
        sock.on('connect', () => sock.write(JSON.stringify({ token: 'nope', prompt: 'Password: ' }) + '\n'))
        sock.on('data', (d) => (buf += d))
        sock.on('end', () => resolve(buf))
      })
      expect(reply).toBe('{}')
    } finally {
      await askpass.stop()
    }
  })

  it('cancels a network operation via AbortSignal', async () => {
    const { server, work } = await setup()
    // A prompt that never answers keeps git waiting until we abort.
    const askpass = new AskpassServer(() => new Promise(() => {}))
    await askpass.start()
    const ac = new AbortController()
    try {
      const op = fetch(work.dir, { remote: 'origin', prune: false, env: askpass.env(), signal: ac.signal })
      setTimeout(() => ac.abort(), 500)
      await expect(op).rejects.toMatchObject({ code: 'CANCELLED' })
    } finally {
      await askpass.stop()
      await server.close()
    }
  })
})

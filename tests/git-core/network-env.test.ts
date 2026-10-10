import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  approveCredential,
  networkEnv,
  parseCredentialPrompt,
  USE_PLATFORM_HELPER,
} from '@git-core/network-env'
import { AskpassServer, isConfirmPrompt, type AskpassPrompt } from '@git-core/askpass'
import { fetch } from '@git-core/remotes'
import { listRefs } from '@git-core/refs'
import { cleanupFixtures, createFixtureRepo, makeTempDir } from '../helpers/fixture'

afterEach(cleanupFixtures)
const posixOnly = process.platform === 'win32' ? it.skip : it

describe('parseCredentialPrompt / isConfirmPrompt', () => {
  it.each([
    ["Username for 'https://github.com': ", { field: 'username', protocol: 'https', host: 'github.com' }],
    ["Password for 'https://alice@github.com': ", { field: 'password', protocol: 'https', host: 'github.com', username: 'alice' }],
    ["Password for 'http://bob%40corp@127.0.0.1:8080': ", { field: 'password', protocol: 'http', host: '127.0.0.1:8080', username: 'bob@corp' }],
  ])('%s', (prompt, expected) => {
    expect(parseCredentialPrompt(prompt)).toEqual(expected)
  })
  it('ignores ssh prompts', () => {
    expect(parseCredentialPrompt("Enter passphrase for key '/home/a/.ssh/id_ed25519': ")).toBeNull()
    expect(parseCredentialPrompt("alice@host's password: ")).toBeNull()
  })
  it('recognizes the ssh host-key question', () => {
    expect(isConfirmPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? ')).toBe(true)
    expect(isConfirmPrompt('Are you sure you want to continue connecting (yes/no)? ')).toBe(true)
    expect(isConfirmPrompt("Password for 'https://x': ")).toBe(false)
  })
})

describe('networkEnv', () => {
  it('fails fast with BatchMode when there is no askpass bridge', async () => {
    const repo = createFixtureRepo()
    const env = await networkEnv(repo.dir)
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
    expect(env.SSH_ASKPASS).toBeUndefined()
  })

  it('routes ssh prompts to the askpass bridge when present', async () => {
    const repo = createFixtureRepo()
    const env = await networkEnv(repo.dir, { GIT_ASKPASS: '/x/askpass.sh' })
    expect(env.SSH_ASKPASS).toBe('/x/askpass.sh')
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force')
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
  })

  it('never replaces a user-configured ssh command', async () => {
    const repo = createFixtureRepo()
    repo.git(['config', 'core.sshCommand', 'ssh -i ~/.ssh/work'])
    expect((await networkEnv(repo.dir)).GIT_SSH_COMMAND).toBeUndefined()
  })

  it('uses the platform credential helper only after opt-in and only without a configured helper', async () => {
    const repo = createFixtureRepo()
    const plain = await networkEnv(repo.dir)
    expect(plain.GIT_CONFIG_COUNT).toBeUndefined()
    const optedIn = await networkEnv(repo.dir, { [USE_PLATFORM_HELPER]: '1' })
    expect(optedIn[USE_PLATFORM_HELPER]).toBeUndefined()
    if (optedIn.GIT_CONFIG_COUNT) {
      expect(optedIn.GIT_CONFIG_KEY_0).toBe('credential.helper')
      expect(optedIn.GIT_CONFIG_VALUE_0).not.toBe('store')
    }
    repo.git(['config', 'credential.helper', 'cache'])
    const configured = await networkEnv(repo.dir, { [USE_PLATFORM_HELPER]: '1' })
    expect(configured.GIT_CONFIG_COUNT).toBeUndefined()
  })
})

describe('approveCredential', () => {
  it("hands credentials to the repository's configured helper", async () => {
    const repo = createFixtureRepo()
    const file = join(makeTempDir(), 'creds')
    // A configured (test-only) helper: never touches the real system keychain.
    repo.git(['config', 'credential.helper', `store --file=${file}`])
    const ok = await approveCredential(repo.dir, { protocol: 'https', host: 'example.test', username: 'al ice', password: 'p@ss:word' })
    expect(ok).toBe(true)
    expect(readFileSync(file, 'utf8').trim()).toBe('https://al%20ice:p%40ss%3aword@example.test')
  })

  it('refuses values containing newlines (credential protocol injection)', async () => {
    const repo = createFixtureRepo()
    const file = join(makeTempDir(), 'creds')
    repo.git(['config', 'credential.helper', `store --file=${file}`])
    expect(await approveCredential(repo.dir, { protocol: 'https', host: 'a.test', username: 'u', password: 'x\nhost=evil.test' })).toBe(false)
    expect(existsSync(file)).toBe(false)
  })
})

describe('ssh prompts through the askpass bridge', () => {
  posixOnly('answers a key passphrase and a new host-key question, then fetches', async () => {
    const seed = createFixtureRepo()
    seed.commit('over ssh', { 'a.txt': '1' })
    const bare = createFixtureRepo({ bare: true })
    seed.git(['push', '-q', bare.dir, 'main'])
    const work = createFixtureRepo()
    work.git(['remote', 'add', 'origin', `ssh://git.example.test${bare.dir}`])

    // Stand-in for OpenSSH: asks the same questions via $SSH_ASKPASS, then runs the git
    // command locally instead of on a server.
    const fakeSsh = join(makeTempDir(), 'fake-ssh')
    writeFileSync(
      fakeSsh,
      [
        '#!/bin/sh',
        'for last; do :; done',
        'pass=$("$SSH_ASKPASS" "Enter passphrase for key \'/home/test/.ssh/id_ed25519\': ") || exit 255',
        '[ "$pass" = "correct horse" ] || { echo "Permission denied (publickey)." >&2; exit 255; }',
        'ok=$("$SSH_ASKPASS" "The authenticity of host \'git.example.test\' can\'t be established.',
        'ED25519 key fingerprint is SHA256:abcdef.',
        'Are you sure you want to continue connecting (yes/no/[fingerprint])? ") || exit 255',
        '[ "$ok" = "yes" ] || { echo "Host key verification failed." >&2; exit 255; }',
        'exec sh -c "$last"',
        '',
      ].join('\n'),
    )
    chmodSync(fakeSsh, 0o755)

    const prompts: AskpassPrompt[] = []
    const askpass = new AskpassServer(async (p) => {
      prompts.push(p)
      return p.confirm ? 'yes' : 'correct horse'
    })
    await askpass.start()
    try {
      await fetch(work.dir, { remote: 'origin', prune: false, env: { ...askpass.env(), GIT_SSH_COMMAND: fakeSsh } })
      expect((await listRefs(work.dir)).map((r) => r.name)).toContain('refs/remotes/origin/main')
      // Git may start ssh more than once per fetch; the stand-in asks both questions each time.
      expect(prompts.length % 2).toBe(0)
      expect(prompts.slice(0, 2).map((p) => [p.secret, p.confirm])).toEqual([
        [true, false],
        [false, true],
      ])
      expect(prompts[1]!.prompt).toContain('SHA256:abcdef')
    } finally {
      await askpass.stop()
    }
  })

  posixOnly('declining the host key fails with a clear message', async () => {
    const bare = createFixtureRepo({ bare: true })
    const work = createFixtureRepo()
    work.git(['remote', 'add', 'origin', `ssh://git.example.test${bare.dir}`])
    const fakeSsh = join(makeTempDir(), 'fake-ssh')
    writeFileSync(
      fakeSsh,
      '#!/bin/sh\nok=$("$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no)? ") || { echo "Host key verification failed." >&2; exit 255; }\nexit 255\n',
    )
    chmodSync(fakeSsh, 0o755)
    const askpass = new AskpassServer(async () => null)
    await askpass.start()
    try {
      await expect(
        fetch(work.dir, { remote: 'origin', prune: false, env: { ...askpass.env(), GIT_SSH_COMMAND: fakeSsh } }),
      ).rejects.toThrow(/Host key verification failed/)
    } finally {
      await askpass.stop()
    }
  })
})

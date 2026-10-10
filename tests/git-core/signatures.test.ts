import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSignature, parseSignature } from '@git-core/signatures'
import { cleanupFixtures, createFixtureRepo, makeTempDir, type FixtureRepo } from '../helpers/fixture'

afterEach(cleanupFixtures)

const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined

/** A throwaway ed25519 key in a temp dir (never the user's ~/.ssh) configured for ssh signing in `repo`. */
function configureSshSigning(repo: FixtureRepo, opts: { allowed: boolean }): void {
  const dir = makeTempDir('gitbob-sshkey-')
  const key = join(dir, 'signing key')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', key], { stdio: 'ignore' })
  const pub = readFileSync(`${key}.pub`, 'utf8').trim()
  const allowed = join(dir, 'allowed_signers')
  writeFileSync(allowed, opts.allowed ? `author@example.com ${pub}\n` : '')
  repo.git(['config', 'gpg.format', 'ssh'])
  repo.git(['config', 'user.signingkey', key])
  repo.git(['config', 'gpg.ssh.allowedSignersFile', allowed])
}

describe('getSignature', () => {
  it('reports unsigned commits as none', async () => {
    const repo = createFixtureRepo()
    const sha = repo.commit('unsigned', { 'f.txt': '1\n' })
    expect(await getSignature(repo.dir, sha)).toEqual({ status: 'none', signer: null, key: null })
  })

  it('validates the commit id', async () => {
    const repo = createFixtureRepo()
    repo.commit('x')
    await expect(getSignature(repo.dir, 'HEAD')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(getSignature(repo.dir, '--format=x')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(getSignature(repo.dir, 'deadbeef')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it.skipIf(!hasSshKeygen)('verifies a good ssh signature', async () => {
    const repo = createFixtureRepo()
    configureSshSigning(repo, { allowed: true })
    repo.write('f.txt', '1\n')
    repo.git(['add', 'f.txt'])
    repo.git(['commit', '-q', '-S', '-m', 'signed'])
    const sig = await getSignature(repo.dir, repo.head())
    expect(sig.status).toBe('good')
    expect(sig.signer).toBe('author@example.com')
    expect(sig.key).toMatch(/^SHA256:/)
  })

  it.skipIf(!hasSshKeygen)('reports a signature by a key that is not an allowed signer', async () => {
    const repo = createFixtureRepo()
    configureSshSigning(repo, { allowed: false })
    repo.git(['commit', '-q', '--allow-empty', '-S', '-m', 'signed'])
    const sig = await getSignature(repo.dir, repo.head())
    // A valid signature by a key that has no allowed-signers entry.
    expect(sig.status).toBe('unknown-validity')
    expect(sig.key).toMatch(/^SHA256:/)
  })

  it.skipIf(!hasSshKeygen)('reports a tampered commit as bad', async () => {
    const repo = createFixtureRepo()
    configureSshSigning(repo, { allowed: true })
    repo.git(['commit', '-q', '--allow-empty', '-S', '-m', 'original message'])
    const raw = repo.git(['cat-file', 'commit', 'HEAD'])
    const forged = raw.replace('original message', 'forged message') + '\n'
    const dir = makeTempDir('gitbob-forge-')
    writeFileSync(join(dir, 'obj'), forged)
    const sha = repo.git(['hash-object', '-t', 'commit', '-w', join(dir, 'obj')])
    expect((await getSignature(repo.dir, sha)).status).toBe('bad')
  })
})

describe('parseSignature', () => {
  it('maps every %G? code', () => {
    const map = { G: 'good', B: 'bad', U: 'unknown-validity', X: 'expired', Y: 'expired-key', R: 'revoked', E: 'missing-key', N: 'none', Q: 'error' }
    for (const [code, status] of Object.entries(map)) {
      expect(parseSignature(`${code}\0Alice <a@x>\0ABCD\n`)).toEqual({ status, signer: 'Alice <a@x>', key: 'ABCD' })
    }
    expect(parseSignature('')).toEqual({ status: 'error', signer: null, key: null })
  })
})

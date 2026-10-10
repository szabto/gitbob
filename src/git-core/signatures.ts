import { GitError } from './errors'
import { runGit } from './runner'
import type { SignatureInfo } from '@shared/types'
export type { SignatureInfo }


const SHA_RE = /^[0-9a-f]{4,64}$/i
/** Verification spawns gpg/gpgsm/ssh-keygen; never let it hang. */
const VERIFY_TIMEOUT = 30_000

const STATUS: Record<string, SignatureInfo['status']> = {
  G: 'good',
  B: 'bad',
  U: 'unknown-validity',
  X: 'expired',
  Y: 'expired-key',
  R: 'revoked',
  E: 'missing-key',
  N: 'none',
}

/** Map `%G?%x00%GS%x00%GK` output. */
export function parseSignature(stdout: string): SignatureInfo {
  const [code = '', signer = '', key = ''] = stdout.replace(/\n$/, '').split('\0')
  return {
    status: STATUS[code.trim()] ?? 'error',
    signer: signer.trim() || null,
    key: key.trim() || null,
  }
}

/**
 * Verify the signature of a commit with the user's configured gpg / ssh / x509 setup
 * (gpg.format, gpg.ssh.allowedSignersFile, ...). `E` ("cannot be checked", usually a missing
 * key or missing allowed-signers file) maps to 'missing-key'.
 */
export async function getSignature(repoPath: string, sha: string): Promise<SignatureInfo> {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new GitError('INVALID_ARGUMENT', 'Invalid commit id')
  const r = await runGit(['log', '-1', '-z', '--format=%G?%x00%GS%x00%GK', `${sha}^{commit}`, '--'], {
    cwd: repoPath,
    timeoutMs: VERIFY_TIMEOUT,
    okExitCodes: [0, 128],
  })
  if (r.exitCode !== 0) throw new GitError('NOT_FOUND', `Commit ${sha} not found`)
  return parseSignature(r.stdout)
}

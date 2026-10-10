import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Disposable Git repositories for integration tests. Every repository lives
 * in a fresh temp directory and is built with the real git CLI using an
 * isolated configuration and deterministic identities/dates.
 */

const created: string[] = []

export function makeTempDir(prefix = 'gitbob-test-'): string {
  // realpath: macOS /var -> /private/var, so paths match what git reports.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  created.push(dir)
  return dir
}

export function cleanupFixtures(): void {
  while (created.length) {
    const dir = created.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
}

let clock = 1_700_000_000

function fixtureEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const t = `${clock} +0000`
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig-fixture'),
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: 'Test Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.com',
    GIT_AUTHOR_DATE: t,
    GIT_COMMITTER_DATE: t,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...extra,
  }
}

export class FixtureRepo {
  constructor(
    readonly dir: string,
    private readonly home: string,
  ) {}

  /** Run git in this repository and return trimmed stdout. */
  git(args: string[], env: Record<string, string> = {}): string {
    return execFileSync('git', args, { cwd: this.dir, env: fixtureEnv(this.home, env), encoding: 'utf8' }).trim()
  }

  write(path: string, content: string | Buffer): void {
    const full = join(this.dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  /**
   * Create a commit. Each commit advances a fake clock by 60s so date order is deterministic.
   * Returns the new commit's full sha.
   */
  commit(message: string, files: Record<string, string | Buffer> = {}): string {
    for (const [p, c] of Object.entries(files)) this.write(p, c)
    if (Object.keys(files).length) this.git(['add', '-A'])
    clock += 60
    this.git(['commit', '--allow-empty', '-q', '-m', message])
    return this.head()
  }

  head(): string {
    return this.git(['rev-parse', 'HEAD'])
  }

  rev(rev: string): string {
    return this.git(['rev-parse', rev])
  }

  branch(name: string, start?: string): void {
    this.git(['branch', name, ...(start ? [start] : [])])
  }

  checkout(name: string): void {
    this.git(['checkout', '-q', name])
  }

  /** Non fast-forward merge; returns the merge commit sha. */
  merge(branch: string, message = `Merge ${branch}`): string {
    clock += 60
    this.git(['merge', '--no-ff', '-q', '-m', message, branch])
    return this.head()
  }

  tag(name: string, opts: { annotated?: boolean; target?: string } = {}): void {
    clock += 1
    const args = opts.annotated ? ['tag', '-a', '-m', `Tag ${name}`, name] : ['tag', name]
    if (opts.target) args.push(opts.target)
    this.git(args)
  }
}

export function createFixtureRepo(opts: { bare?: boolean; initialBranch?: string } = {}): FixtureRepo {
  const home = makeTempDir('gitbob-home-')
  const dir = makeTempDir('gitbob-repo-')
  const repo = new FixtureRepo(dir, home)
  repo.git(['init', '-q', `--initial-branch=${opts.initialBranch ?? 'main'}`, ...(opts.bare ? ['--bare'] : [])])
  return repo
}

/** Clone `source` into a new temp directory (gives a repository with remote-tracking refs). */
export function cloneFixtureRepo(source: FixtureRepo): FixtureRepo {
  const home = makeTempDir('gitbob-home-')
  const parent = makeTempDir('gitbob-clone-')
  const dir = join(parent, 'clone')
  execFileSync('git', ['clone', '-q', source.dir, dir], { env: fixtureEnv(home), encoding: 'utf8' })
  return new FixtureRepo(dir, home)
}

/**
 * Point git invoked through `runGit` (which inherits process.env) at an isolated
 * home/config with a fixed identity, so the developer's global config (signing,
 * hooksPath, excludesFile, ...) cannot influence tests. Returns a restore function.
 */
export function isolateProcessGitEnv(): () => void {
  const home = mkdtempSync(join(tmpdir(), 'gitbob-env-home-'))
  const vars: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig-fixture'),
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: 'Test Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.com',
  }
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  }
}

/** Create a conflicting merge in `repo` (leaves the merge in progress). Returns the conflicted path. */
export function makeMergeConflict(repo: FixtureRepo, path = 'conflict.txt'): string {
  repo.commit('base', { [path]: 'base\n' })
  repo.branch('other')
  repo.commit('ours', { [path]: 'ours\n' })
  repo.checkout('other')
  repo.commit('theirs', { [path]: 'theirs\n' })
  repo.checkout('main')
  try {
    repo.git(['merge', '-q', '--no-ff', '-m', 'merge other', 'other'])
  } catch {
    /* expected: conflict */
  }
  return path
}

/**
 * Give `path` conflicting edits on `main` ("ours") and on a new branch `other` ("theirs"),
 * both based on a common commit, and leave `main` checked out with a clean tree.
 */
export function makeDivergedBranches(
  repo: FixtureRepo,
  path = 'conflict.txt',
): { base: string; ours: string; theirs: string; path: string } {
  const base = repo.commit('base', { [path]: 'base\n' })
  repo.branch('other')
  const ours = repo.commit('ours', { [path]: 'ours\n' })
  repo.checkout('other')
  const theirs = repo.commit('theirs', { [path]: 'theirs\n' })
  repo.checkout('main')
  return { base, ours, theirs, path }
}

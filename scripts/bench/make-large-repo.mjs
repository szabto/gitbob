#!/usr/bin/env node
// Generates a large, deterministic synthetic Git repository for benchmarks.
//
//   node scripts/bench/make-large-repo.mjs [commits=100000] [outDir] [--seed=N] [--commit-graph]
//
// History shape (seeded, reproducible): a main line, up to ~30 concurrently
// active feature branches that fork from main and merge back (~20% of all
// commits are merges), and a few long-lived release branches that receive
// fixes and are merged back into main. At the end ~1,000 branch refs
// (local + remote-tracking) and ~200 tags are created.
//
// The stream is fed to `git fast-import` over stdin (argument arrays only,
// never a shell). Each commit touches one small file using a handful of
// reused blobs, so generation takes seconds even for 100k commits.
// outDir must not exist or be empty; it defaults to a fresh temp directory.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const total = Number(positional[0] ?? 100_000)
if (!Number.isInteger(total) || total < 10) {
  console.error('commit count must be an integer >= 10')
  process.exit(2)
}
const seedArg = [...flags].find((f) => f.startsWith('--seed='))
let seed = seedArg ? Number(seedArg.slice('--seed='.length)) : 42
const writeCommitGraph = flags.has('--commit-graph')

let outDir
if (positional[1]) {
  outDir = resolve(positional[1])
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    console.error(`refusing to write into non-empty directory ${outDir}`)
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })
} else {
  outDir = realpathSync(mkdtempSync(join(tmpdir(), 'gitbob-large-')))
}

// Mulberry32: small, fast, deterministic PRNG.
function rand() {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

const env = {
  PATH: process.env.PATH,
  HOME: outDir,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(outDir, '.git', 'no-global-config'),
  LC_ALL: 'C',
}
const git = (...a) => execFileSync('git', a, { cwd: outDir, env, encoding: 'utf8', maxBuffer: 1 << 28 }).trim()

const t0 = performance.now()
git('init', '-q', '-b', 'main')

const PEOPLE = ['Ada Byron', 'Linus Ortega', 'Grace Hopkins', 'Ken Tamura', 'Barbara Liskov', 'Edsger Wyk', 'Margaret Ham']
const BLOB_COUNT = 16
const FILE_COUNT = 64

const chunks = []
const out = (s) => {
  chunks.push(s)
}

// Reused blobs: marks 1..BLOB_COUNT.
for (let b = 1; b <= BLOB_COUNT; b++) {
  const data = `blob ${b}\n${'x'.repeat(b * 8)}\n`
  out(`blob\nmark :${b}\ndata ${Buffer.byteLength(data)}\n${data}\n`)
}

let nextMark = BLOB_COUNT + 1
let clock = 1_600_000_000
let commits = 0
let merges = 0
const SCRATCH = 'refs/gitbob-bench/scratch'

/** Emit one commit and return its mark. parents[0] is the first parent. */
function commit(parents, subject) {
  const mark = nextMark++
  clock += 30 + Math.floor(rand() * 600)
  // Rare clock skew: a commit dated before its parents (exercises --date-order).
  const when = rand() < 0.003 ? clock - 86_400 * (1 + Math.floor(rand() * 30)) : clock
  const name = pick(PEOPLE)
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`
  const msg = `${subject}\n`
  let s = `commit ${SCRATCH}\nmark :${mark}\n`
  s += `author ${name} <${email}> ${when} +0000\ncommitter ${name} <${email}> ${when} +0000\n`
  s += `data ${Buffer.byteLength(msg)}\n${msg}`
  if (parents.length > 0) s += `from :${parents[0]}\n`
  for (const p of parents.slice(1)) s += `merge :${p}\n`
  s += `M 100644 :${1 + Math.floor(rand() * BLOB_COUNT)} src/file${Math.floor(rand() * FILE_COUNT)}.txt\n\n`
  out(s)
  commits++
  if (parents.length > 1) merges++
  return mark
}

// --- History simulation -----------------------------------------------------
const MAX_FEATURES = 30
let main = commit([], 'Initial commit')
/** Active feature branches: { id, tip, length, target } */
const features = []
/** Long-lived release branches: { name, tip } */
const releases = []
/** Feature tips kept for branch refs (bounded reservoir). */
const keptFeatures = []
let featureId = 0
let releaseNo = 0
const tags = []
// Spread ~200 tags across the whole history regardless of its size.
const TAG_P = Math.min(0.5, 220 / total)

while (commits < total) {
  const r = rand()
  if (r < 0.25 && features.length < MAX_FEATURES) {
    // Fork a new feature from main (or occasionally from a release).
    const base = releases.length > 0 && rand() < 0.15 ? pick(releases).tip : main
    features.push({ id: ++featureId, tip: base, length: 0, target: 1 + Math.floor(rand() * 6) })
  } else if (r < 0.27 && commits > 500 && (releases.length === 0 || rand() < 0.02)) {
    // Cut a release branch from main; keep at most 4 alive.
    releaseNo++
    releases.push({ name: `release/${Math.floor(releaseNo / 10) + 1}.${releaseNo % 10}`, tip: main })
    if (releases.length > 4) releases.shift()
  } else if (r < 0.8) {
    // Work on a feature branch; merge it when it reaches its target length.
    if (features.length === 0) continue
    const fi = Math.floor(rand() * features.length)
    const f = features[fi]
    f.tip = commit([f.tip], `feature-${f.id}: change ${f.length + 1}`)
    f.length++
    if (f.length >= f.target && commits < total) {
      main = commit([main, f.tip], `Merge branch 'feature/${f.id}'`)
      features.splice(fi, 1)
      if (keptFeatures.length < 1000) keptFeatures.push(f)
      else if (rand() < 0.1) keptFeatures[Math.floor(rand() * keptFeatures.length)] = f
    }
  } else if (r < 0.86 && releases.length > 0) {
    // Fix on a release branch, sometimes merged back to main.
    const rel = pick(releases)
    rel.tip = commit([rel.tip], `${rel.name}: fix`)
    if (rand() < 0.25 && commits < total) main = commit([main, rel.tip], `Merge branch '${rel.name}'`)
  } else {
    // Direct commit on main.
    main = commit([main], `main: change ${commits}`)
  }
  if (tags.length < 200 && rand() < TAG_P) {
    const rel = releases.length > 0 && rand() < 0.5 ? pick(releases) : null
    tags.push(rel ? { name: `v${releaseNo}.${tags.length + 1}`, mark: rel.tip } : { name: `main-${tags.length + 1}`, mark: main })
  }
}

// --- Refs ---------------------------------------------------------------------
const reset = (ref, mark) => out(`reset ${ref}\nfrom :${mark}\n\n`)
reset('refs/heads/main', main)
for (const rel of releases) reset(`refs/heads/${rel.name}`, rel.tip)
for (const f of features) reset(`refs/heads/feature/${f.id}`, f.tip)
// ~1,000 branch refs total: merged feature branches nobody deleted, split
// between local branches and remote-tracking branches.
keptFeatures.forEach((f, i) => {
  reset(i % 3 === 0 ? `refs/remotes/origin/feature/${f.id}` : `refs/heads/feature/${f.id}`, f.tip)
})
reset('refs/remotes/origin/main', main)
for (const t of tags) reset(`refs/tags/${t.name}`, t.mark)
out('done\n')

const tGen = performance.now()
await new Promise((resolveP, reject) => {
  const child = spawn('git', ['fast-import', '--quiet', '--done'], { cwd: outDir, env, stdio: ['pipe', 'inherit', 'inherit'] })
  child.on('error', reject)
  child.on('close', (code) => (code === 0 ? resolveP() : reject(new Error(`git fast-import exited with ${code}`))))
  child.stdin.end(chunks.join(''))
})
git('update-ref', '-d', SCRATCH)
git('symbolic-ref', 'HEAD', 'refs/heads/main')
git('reset', '-q', '--hard', 'main')
const tImport = performance.now()
if (writeCommitGraph) git('commit-graph', 'write', '--reachable')
const tEnd = performance.now()

const refCount = git('for-each-ref', '--format=%(refname)').split('\n').length
console.log(
  JSON.stringify(
    {
      dir: outDir,
      commits,
      merges,
      mergeRatio: Number((merges / commits).toFixed(3)),
      refs: refCount,
      tags: tags.length,
      commitGraph: writeCommitGraph,
      ms: {
        generateStream: Math.round(tGen - t0),
        fastImport: Math.round(tImport - tGen),
        commitGraph: Math.round(tEnd - tImport),
        total: Math.round(tEnd - t0),
      },
    },
    null,
    2,
  ),
)

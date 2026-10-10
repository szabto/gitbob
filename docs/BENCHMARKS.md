# Benchmarks

History loading and graph layout on a large synthetic repository (milestone M4, performance part).
Numbers are measured, not estimated; all of them come from the commands below.

## Machine

| | |
|---|---|
| CPU | Apple M5 Pro (18 cores), 24 GB RAM |
| OS | macOS 27.0.1 |
| Node | v25.8.1 (Vitest 5.0.3, run with `pool: 'forks'`) |
| Git | git version 2.54.0 (Apple Git-157) |
| Date | 2026-10-10 |

The machine was not idle (other build/test jobs ran concurrently, load average ≈ 5–6), so single runs vary by roughly ±20%. "After" values are the median of three full benchmark runs. Only macOS has been measured; Windows and Linux numbers are **not measured**.

## Reproduce

```sh
# Generate a repository by itself (defaults: 100,000 commits, temp dir, seed 42)
node scripts/bench/make-large-repo.mjs 100000 /tmp/gitbob-large --commit-graph

# Full benchmark: generates the repo in a temp dir, measures, deletes it
GITBOB_BENCH=1 npx vitest run tests/bench
# optional: GITBOB_BENCH_COMMITS=20000, GITBOB_BENCH_OUT=results.json
```

`tests/bench/history.bench.test.ts` is skipped in the normal `npx vitest run` (it is guarded by `describe.skipIf(!process.env.GITBOB_BENCH)`).

### Synthetic repository

`scripts/bench/make-large-repo.mjs` feeds a seeded stream to `git fast-import` (argument arrays, no shell); 100k commits take about 5.5 s.

- 100,000 commits, 99,836 reachable from refs (the rest sit on release branches that were retired without being merged)
- 19,013 merges (19%); up to 30 feature branches open at once (the graph is 35–58 lanes wide); up to 4 long-lived release branches that receive fixes and are merged back now and then
- 0.3% of commits are dated before their parents, to exercise `--date-order`
- 1,229 refs: 694 local branches, 335 remote-tracking branches, 200 tags
- Each commit changes one file, chosen from 64 paths and 16 reused blobs (pack size about 30 MB)

Each history scenario runs twice. The first run has **no commit-graph file**: that is what fast-import produces, and it matches a fresh clone before any maintenance. The second run follows `git commit-graph write --reachable`, which is what `git gc` and `git maintenance` leave behind in most long-lived clones.

## Results

Page size is 2,000, the same as the renderer's `PAGE_SIZE`. "All pages" means 50 sequential `getCommitPage` calls with `skip += 2000`, as the renderer's infinite query does them. Each run checks that the concatenated pages equal one full `git log --date-order` run, every field of every commit.

### History loading (`src/git-core/log.ts`)

| Scenario | Before | After |
|---|---:|---:|
| First page (2k), no commit-graph | 370 ms | 352 ms |
| First page (2k), commit-graph | 110 ms | 92 ms |
| Later page (each), no commit-graph | 300–400 ms | ~44 ms |
| Later page (each), commit-graph | 100–110 ms | ~45 ms |
| Page 2 (builds the walk order once), no commit-graph | 324 ms | 390 ms |
| **All 50 pages (100k), no commit-graph** | **16.9 s** | **2.8 s** |
| **All 50 pages (100k), commit-graph** | **5.4 s** | **2.3 s** |
| All pages again, refs unchanged (refetch), no commit-graph | 17.9 s | 2.5 s |
| Reference: one full `git log` run, no paging | 450–680 ms | (same) |
| Reference: raw `git log --skip` per page, no commit-graph, first page / page at skip≈98k | 295 / 311 ms | (same) |

How `--skip` scales: in this git version, `--skip` does not make later pages noticeably slower than early ones. Every page costs about the same because every page pays for a whole walk. Without a commit-graph, `--date-order` must load and sort the entire history before it can print the first commit, so each page costs about 300 ms whatever its position, and 50 pages make 50 full walks. With a commit-graph, generation numbers let git stream in date order: the first page drops to about 65 ms, and pages near the end rise to 70–80 ms because the skipped commits are still walked. Either way the total grows as pages × history size, which is quadratic in history length.

### `parseLog` and `listRefs`

| Scenario | Time |
|---|---:|
| `parseLog`, full 100k output (20.8 MB) | 39–58 ms |
| Retained heap of 99,836 parsed `CommitSummary` objects | 37.4 MB |
| `listRefs`, 1,229 refs | 45–50 ms |

`listRefs` time is mostly process spawn plus `for-each-ref` with upstream tracking info. It was not changed.

### Graph layout (`src/git-graph/layout.ts`)

| Scenario | Before | After |
|---|---:|---:|
| `computeGraphLayout`, 2k commits (width 35) | 4.9–6.6 ms | 0.5 ms |
| `computeGraphLayout`, 20k commits (width 42) | 55–66 ms | 7.9 ms |
| `computeGraphLayout`, 100k commits (width 58) | 216–310 ms | 42 ms |
| `GraphLayoutBuilder`, 50 appends of 2k | 255–290 ms | 36 ms |
| Full recompute after every page (what `CommitGraph.tsx` does today), 50 pages | 7.2 s | 0.95 s |
| **Retained heap, 100k-row layout** (3.25 M segments) | **229.6 MB** | **87.2 MB** |

"Before" layout values are given as a range because two separate runs disagreed by up to 30% under load.

## What changed

### `getCommitPage`: cached walk order instead of `--skip`

- **First page (`skip: 0`)**: a single bounded `git log --date-order --max-count=limit+1` walk, as before. `getHead` and the ref listing now run in parallel (first page with commit-graph: 110 → 92 ms).
- **Later pages (`skip > 0`)**:
  1. Fetch the ordered object ids once with `git rev-list --date-order <same revs>`. That takes about 360 ms on 100k commits without a commit-graph and about 110 ms with one, and the result is a 4 MB fixed-width string.
  2. Cache that list per repository, keyed by a fingerprint of the walk's inputs. The cache holds at most 4 repositories (least recently used is dropped).
  3. Serve each page by slicing the list and formatting only those ids with `git log --no-walk=unsorted --stdin -z`, which takes about 25 ms for 2k commits.
- **The fingerprint** covers every walk input. Commit objects are immutable, so the order can change only if one of these changes:
  - HEAD's commit
  - every `refs/heads`, `refs/remotes` and `refs/tags` tip
  - `refs/replace/*`, which rewrites parents
  - the size and mtime of the `shallow` file, which changes when a clone is deepened
- **Fallback**: if anything unexpected fails (other than cancellation), the cache is dropped and the page comes from the original `--skip` walk.
- **Concurrency and cancellation**: concurrent requests share one rev-list build. A caller's `AbortSignal` cancels only that caller's wait.
- **API**: unchanged (`getCommitPage(repoPath, {skip, limit, signal})` → `{commits, hasMore}`). `clearLogCache()` is exported for tests.
- **New tests** (`tests/git-core/log.test.ts`):
  - Concatenated pages equal one full `git log` run for page sizes 1, 2, 3, 7, n−1, n and n+5. The history includes merges, 3 roots, skewed dates, an annotated tag and a commit reachable only from a tag.
  - Arbitrary unaligned windows return the right commits.
  - The cache is invalidated by a new commit, a deleted branch, a detached HEAD, a replace graft and a shallow deepen. Mutation-checked: dropping replace refs and shallow state from the fingerprint makes those two tests fail.
  - Cancellation works on later pages.

### `GraphLayoutBuilder`

- **Lane lookup**: a `Map<sha, laneIndex>` replaces the `findIndex` and `forEach` scans per row and per parent. A sha is expected by at most one lane, because a lane is opened only when no lane already expects that parent.
- **Shared segments**: each lane allocates its vertical `{from: i, to: i, color}` segment once. That one object is shared by the lane's outgoing edge and every row the lane passes through, and the incoming edge into the node is the same object. `Segment` fields are now `readonly`, and the renderer only reads them. This removed about 3 M allocations per 100k rows and is most of the heap and time savings.
- **Width**: computed as `max(column+1, laneCountBeforeRow, laneCountAfterRow)`. This is equivalent to the old calculation because trailing empty lanes are trimmed after every row, and it replaces `Math.max(...spread)` over every segment.
- **Output**: identical to the original algorithm. A new oracle test compares against a verbatim copy of the old implementation on 40 random 300-commit DAGs and on edge cases (duplicate parents, parentless tips, octopus merges, parents outside the page).

## What still does not scale or was not measured

- **Renderer costs were not measured**: React rendering, the virtualizer, per-row SVG, and IPC serialization of 2k-commit pages (structured clone of about 420 KB of strings per page). These need an Electron-level benchmark (for example a Playwright trace), which does not exist yet.
- **`CommitGraph.tsx` recomputes the whole layout on every new page** (`useMemo(() => computeGraphLayout(commits))`). For 100k commits that is quadratic: 0.95 s in total now, 7.2 s before. Appending to one `GraphLayoutBuilder` per history would cost 36 ms in total, but that change belongs to the renderer and is out of scope here.
- **Layout memory is still O(rows × width)**: 87 MB for 100k rows of width up to 58, because every row holds its own `passThrough` array. A run-length or interval representation of lanes would bring this near O(rows), but it would change the `GraphRow` contract that the renderer consumes.
- **Parsed commits**: the main process transiently holds about 37 MB of `CommitSummary` objects per 100k commits, and the renderer keeps its own copy.
- **The first page without a commit-graph is still bound by git**: about 350 ms for 100k commits, and it grows linearly with history. `--date-order` must sort everything before printing anything. Writing a commit-graph file brings it to about 90 ms, but GitBob does not write one automatically.
- **Page 2 costs about one full walk** (the one-time rev-list build). The order cache is in memory only, so it is rebuilt after any ref change and after an app restart.
- **Not benchmarked**:
  - histories of 1M+ commits
  - Windows and Linux
  - network filesystems
  - repositories with very large refs counts (10k+), where both `for-each-ref` per page and `listRefs` will grow

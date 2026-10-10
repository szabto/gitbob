<p align="center">
  <a href="https://gitbob.app/">
    <img alt="GitBob" src="resources/icon.png" width="160">
  </a>
</p>

<h1 align="center">GitBob</h1>

<p align="center">
  <b>A free desktop Git client with a beautiful commit graph and everything you need every day.</b><br>
  See your whole history at a glance, stage and commit with real diffs, juggle branches,<br>
  and sync with your remotes without memorizing a single command. Your Git, just friendlier.
</p>

<p align="center">
  <img alt="Free to use" src="https://img.shields.io/badge/price-free-3ee0f5?style=flat-square">
  <img alt="Electron + React + TypeScript" src="https://img.shields.io/badge/Electron%20%C2%B7%20React%20%C2%B7%20TypeScript-desktop-b46cff?style=flat-square">
  <img alt="Platform: macOS (Windows and Linux planned)" src="https://img.shields.io/badge/macOS-verified-2f7bf5?style=flat-square&logo=apple">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3a3a3a?style=flat-square">
  <img alt="Status: early alpha" src="https://img.shields.io/badge/status-early%20alpha-d69e2e?style=flat-square">
</p>

<p align="center">
  <a href="https://gitbob.app/"><b>gitbob.app</b></a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#how-to-use-gitbob">How to use it</a> ·
  <a href="#features">Features</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#for-developers">For developers</a>
</p>

<br>

<p align="center">
  <img src="docs/images/gitbob-graph.png" alt="GitBob showing the history of a project as a colorful commit graph: feature branches fork from main and merge back, branch and tag labels sit next to commit messages, and the details of a selected merge commit are shown on the right" width="100%">
  <br>
  <sub>The commit graph of a small project: feature branches, merges, tags, remote branches and uncommitted work, with a merge commit selected.</sub>
</p>

> [!NOTE]
> **GitBob is free.** No account, no sign-up, no telemetry. It works offline and talks only to the Git remotes you use.

<br>

<table>
  <tr>
    <td width="25%" valign="top">
      <h3>🌈 See everything</h3>
      Every branch, merge and tag drawn as a clear, colorful graph. Click any commit to see who changed what, and why.
    </td>
    <td width="25%" valign="top">
      <h3>✍️ Commit with confidence</h3>
      Review each change as a diff, pick exactly which files go in, write a message and commit. Fix the last commit with Amend.
    </td>
    <td width="25%" valign="top">
      <h3>🌿 Branch without fear</h3>
      Create, switch, rename and delete branches with a right-click. Fetch, pull and push with one button each.
    </td>
    <td width="25%" valign="top">
      <h3>🛟 Hard to break things</h3>
      Risky actions always ask first. Discarded new files go to your Trash, not into the void. Force pushes use <code>--force-with-lease</code>.
    </td>
  </tr>
</table>

<br>

## Get started

> [!IMPORTANT]
> GitBob is in **early alpha**. Signed installers are not published yet. Until then you can run it from source in a few minutes.

**You need:** [Git](https://git-scm.com/downloads) (2.30 or newer) and [Node.js](https://nodejs.org/) (22 or newer).

```sh
git clone https://github.com/szabto/gitbob.git
cd gitbob
npm install
npm run dev
```

GitBob opens. Click **Open Repository…** and choose any folder that contains a Git project. That's it.

Want a real app bundle instead? `npm run dist:mac` builds an (unsigned) `.dmg` into `release/`. Because it isn't signed yet, macOS will ask you to confirm the first launch (right-click the app → **Open**).

**Platforms:** everything below is tested on **macOS**. Windows and Linux builds are configured but not tested yet.

<br>

## How to use GitBob

New to Git, or just new to GitBob? This is the whole tour.

### 1. Open a project

Click **Open Repository…** (or press <kbd>⌘O</kbd> / <kbd>Ctrl+O</kbd>) and pick your project folder. GitBob remembers it, so next time it's one click away on the start screen.

<p align="center">
  <img src="docs/images/gitbob-welcome.png" alt="The GitBob start screen with the panda logo, an Open Repository button and a list of recent repositories" width="80%">
</p>

### 2. Read the graph

Each row is a **commit**, a saved snapshot of your project, newest at the top.

- **Colored lines** are lines of work. When a line splits off, someone started a branch; when two lines join, a branch was merged.
- **Labels** next to a message show where branches point: <code>main</code> is a local branch, <code>origin/main</code> is the same branch on the server, and 🏷 marks a tag such as a release.
- The **ringed dot** is where you are right now (HEAD). The ● in the left sidebar marks your current branch, and arrows like ↑1 ↓2 tell you how many commits you are ahead of or behind the server.
- Click a commit to see its full message, author, parents and changed files. Click a file to see exactly what changed.

Looking for something? Press <kbd>⌘F</kbd> / <kbd>Ctrl+F</kbd> and type part of a message, an author's name or a commit id. GitBob searches the **entire** history, highlights the matches and jumps between them with <kbd>Enter</kbd>.

### 3. Save your work (commit)

When you change files, a **// WIP** row appears at the top of the graph. Click it.

<p align="center">
  <img src="docs/images/gitbob-staging.png" alt="The working changes view: on the right, unstaged and staged files with Stage and Discard buttons and a commit message form; in the middle, the diff of src/App.tsx with added lines in green and removed lines in red" width="100%">
  <br>
  <sub>Reviewing a change before committing it. Green lines were added, red lines removed.</sub>
</p>

1. **Look at your changes.** Click a file to see its diff in the middle.
2. **Stage what belongs together.** Hover a file and click **Stage** (or **Stage all**). Staged files are what goes into the next commit.
3. **Describe it.** Type a short summary (and optionally a longer description).
4. Click **Commit**. Done. Made a typo? Tick **Amend** to change the last commit instead.

Want only part of a file in the commit? Every block of changes (a *hunk*) has its own **Stage hunk** button, and you can click individual green or red lines to select them and press **Stage 2 lines**. The same works backwards for **Unstage** and **Discard**. Prefer reading changes next to each other? Switch the diff to **Side by side** for a syntax-highlighted, two-column view.

Changed your mind about a file? **Discard** throws away its unstaged edits after asking you first. Staged changes are kept, and brand-new files are moved to the Trash so you can still get them back.

### 4. Work with branches

<p align="center">
  <img src="docs/images/gitbob-branches.png" alt="The branch context menu in the sidebar with Checkout, Create branch here, Rename, Set upstream and Delete" width="100%">
</p>

- **New branch:** click **Branch** in the toolbar (it starts from where you are), or right-click any commit → **Create branch here…**
- **Switch branch:** double-click it in the sidebar. Double-clicking a remote branch such as `origin/feature` creates a local copy that tracks it.
- **Rename, delete, set upstream:** right-click the branch. GitBob refuses to delete a branch whose work isn't merged anywhere unless you confirm twice.
- **Look at an old version:** right-click a commit → **Checkout this commit**.

GitBob never overwrites your uncommitted changes when switching. If Git would have to, it tells you instead.

### 5. Sync with the server

| Button | What it does |
|---|---|
| **Fetch** | Downloads what's new on the server without touching your files. Remote labels move; your branch stays put. |
| **Pull** | Brings the server's new commits into your current branch. By default it only fast-forwards; use the ▾ menu to merge or rebase when histories have diverged. |
| **Push** | Uploads your commits. A brand-new branch is published and linked to the server automatically. |

If the server needs a username and password (or token), GitBob asks for it in a dialog. Long operations show their progress and can be cancelled. SSH keys and Git credential helpers you already use keep working.

### 6. Undo, park and reuse work

Right-click any commit for the time-travel tools:

<p align="center">
  <img src="docs/images/gitbob-history-menu.png" alt="The commit context menu with Create branch, Create tag, Cherry-pick, Revert, three Reset options and Checkout" width="100%">
</p>

- **Cherry-pick** copies that commit onto your current branch.
- **Revert** adds a new commit that undoes it (safe for shared branches).
- **Reset** moves your branch back to that commit. *Soft* keeps the changes staged, *mixed* keeps them as unstaged edits, *hard* throws them away. Before a hard reset GitBob asks you, and saves your uncommitted work as a backup stash so it can come back.
- **Create tag** marks a release, with an optional message. Push or delete tags from the sidebar.

Need to switch tasks with half-finished work? Click **Stash…** in Working changes. Your edits are put aside and the working tree is clean. They wait under **Stashes** in the sidebar, where **Pop** brings them back.

<p align="center">
  <img src="docs/images/gitbob-stash.png" alt="A stash selected in the sidebar, with its files and Pop, Apply and Delete buttons" width="100%">
</p>

If a merge, rebase, cherry-pick or revert stops because of a conflict, a yellow banner tells you how many files need attention and offers **Continue**, **Skip** and **Abort**. Click a conflicted file in Working changes to open the conflict editor: your version and theirs side by side on top, the result below. Pick **Ours**, **Theirs** or **Both** for each conflict (or edit the result yourself), then **Save and mark resolved** and press **Continue**.

<p align="center">
  <img src="docs/images/gitbob-conflict.png" alt="The conflict editor: ours and theirs versions of settings.ts side by side on top, the editable result with conflict markers below, and Ours, Theirs and Both buttons for the conflict" width="100%">
</p>

<br>

## Features

Every screenshot in this README is the real app working on a real Git repository, captured automatically by `npm run screenshots`.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/gitbob-graph.png" alt="Commit graph with branches, merges, tags and commit details" width="100%">
      <h3>A graph you can actually read</h3>
      All local branches, remote branches, tags and HEAD in one view, newest first. Lanes keep their colors, merges curve in clearly, and only the rows on screen are drawn, so long histories stay smooth while more history loads as you scroll.
      <br><br>
      Commit details show the full message, author and committer, parents (click to jump) and every changed file with added and removed line counts.
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/gitbob-commit-diff.png" alt="Diff of a file changed in a commit, with line numbers and added lines highlighted" width="100%">
      <h3>Diffs for everything</h3>
      See changes for unstaged files, staged files, brand-new files, and any file in any commit. Line numbers on both sides, renames and binary files recognized, huge files truncated safely instead of freezing the app.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/gitbob-staging.png" alt="Staging panel and commit composer" width="100%">
      <h3>Staging and committing</h3>
      Stage and unstage single files or everything at once, also in brand-new repositories without any commits. Commit with a summary and description, or amend the previous commit with its message filled in. Hook failures and "nothing to commit" are reported clearly.
      <br><br>
      Edits made in your editor or terminal show up automatically.
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/gitbob-branches.png" alt="Branch context menu" width="100%">
      <h3>Branches and remotes</h3>
      Create, switch, rename and delete branches, track remote branches, and see ahead/behind counts. Add and remove remotes. Fetch (with pruning), pull (fast-forward, merge or rebase) and push with clear explanations when the server rejects something, for example "Pull first" instead of a wall of Git output.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/gitbob-side-by-side.png" alt="Side-by-side diff with syntax highlighting" width="100%">
      <h3>Side by side, line by line</h3>
      A two-column diff with syntax highlighting for about 80 languages, powered by the same editor as VS Code. In the unified view, stage, unstage or discard single hunks or hand-picked lines.
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/gitbob-conflict.png" alt="Three-way conflict editor" width="100%">
      <h3>Conflicts without fear</h3>
      Ours and theirs side by side, an editable result below, one click per conflict. GitBob refuses to mark a file resolved while conflict markers remain.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/gitbob-search.png" alt="Searching the history for forecast: matching commits are highlighted and the rest are dimmed" width="100%">
      <h3>Find anything</h3>
      <kbd>⌘F</kbd> searches the whole history (not just what's on screen) by message, author, committer or commit id. Matches light up, everything else fades, and <kbd>Enter</kbd> jumps to the next one, loading older history when needed.
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/gitbob-light.png" alt="GitBob in the light theme" width="100%">
      <h3>Light or dark</h3>
      Pick Light, Dark or Match System under View → Theme. Graph colors, diffs and labels are tuned for both.
    </td>
  </tr>
</table>

<br>

## Everything in the box

<table>
  <tr>
    <td width="33%" valign="top">
      <h4>📜 History</h4>
      Commit graph across all branches, remotes and tags · merge and octopus-merge lanes · branch/tag/HEAD labels · commit details · whole-history search by message, author or id · keyboard navigation · incremental loading
    </td>
    <td width="33%" valign="top">
      <h4>🧩 Working tree</h4>
      Status with added, modified, deleted, renamed, untracked and conflicted files · stage/unstage files, hunks or single lines · discard with confirmation (new files go to the Trash) · unified and side-by-side diffs with syntax highlighting · three-way conflict editor · commit · amend · merge/rebase/cherry-pick in progress indicator · live refresh
    </td>
    <td width="33%" valign="top">
      <h4>🌿 Branches &amp; sync</h4>
      Create · checkout (local, remote-tracking, detached) · rename · delete (with unmerged protection) · upstream and ahead/behind · remotes add/remove · fetch with prune · pull ff-only/merge/rebase · push with upstream · force-with-lease · HTTPS credential prompt · progress and cancel
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h4>⏪ Undo &amp; reuse</h4>
      Cherry-pick · revert (merge commits too) · reset soft/mixed/hard with automatic backup · continue/skip/abort for stopped merges, rebases, cherry-picks and reverts
    </td>
    <td width="33%" valign="top">
      <h4>📦 Stash &amp; tags</h4>
      Stash with message (untracked files included) · pop · apply · delete · see stashed files · annotated and lightweight tags · push and delete tags
    </td>
  <tr>
    <td width="33%" valign="top">
      <h4>🎨 Comfortable</h4>
      Light, dark or match-system theme (View → Theme) · native menus · keyboard navigation · remembers recent repositories
    </td>
  </tr>
</table>

### On the roadmap

Interactive rebase, reflog browser, blame, worktrees and submodules, clone and init, repository tabs, GitHub/GitLab/Bitbucket/Azure DevOps integration, and signed installers for macOS, Windows and Linux.

<br>

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Open repository | <kbd>⌘O</kbd> | <kbd>Ctrl+O</kbd> |
| Search history | <kbd>⌘F</kbd> | <kbd>Ctrl+F</kbd> |
| Next / previous match | <kbd>Enter</kbd> / <kbd>⇧Enter</kbd> | <kbd>Enter</kbd> / <kbd>Shift+Enter</kbd> |
| Move through commits | <kbd>↑</kbd> <kbd>↓</kbd> | <kbd>↑</kbd> <kbd>↓</kbd> |
| Commit | <kbd>⌘Enter</kbd> in the message box | <kbd>Ctrl+Enter</kbd> |
| Close a dialog / clear search | <kbd>Esc</kbd> | <kbd>Esc</kbd> |

<br>

## FAQ

**Is it really free?** Yes. GitBob costs nothing, needs no account, and its source code is MIT licensed.

**Does it replace Git?** No. GitBob uses the Git already installed on your computer for every operation, so your repositories stay 100% standard. You can switch between GitBob, your terminal and other tools at any time.

**Will it mess up my repository?** GitBob only does what you ask, through Git itself. Anything that can lose work asks for confirmation first (made by the app itself, so nothing can skip it), and discarded new files go to the Trash.

**Where are my passwords stored?** GitBob doesn't store them. When Git asks for credentials, GitBob shows a dialog and passes your answer to Git for that one operation. If you use a Git credential helper (for example the macOS Keychain helper), that helper may remember it, exactly as it does on the command line.

**Does it send data anywhere?** No telemetry, no analytics. The only network traffic is Git talking to your remotes when you fetch, pull or push.

**Windows and Linux?** Builds are configured and planned. They aren't tested yet, so we don't promise them yet.

<br>

## For developers

GitBob is an Electron app written in TypeScript with React. Git operations run in the main process through the installed `git` binary (argument arrays, never a shell); the sandboxed UI talks to it through a small, validated IPC API.

```sh
npm run dev          # run with hot reload
npm run check        # typecheck + lint + unit/integration tests
npm run test:e2e     # build and run end-to-end tests that drive the real app
npm run screenshots  # regenerate the README screenshots
npm run dist:mac     # package for macOS (dmg + zip)
```

- **Fast on big repositories:** measured on a generated 100,000-commit repository: the full history loads in about 3 seconds and the graph layout takes about 40 ms ([`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)).
- **Tested against real Git:** more than 350 integration tests (including randomized partial-staging checks) create throwaway repositories (including local "servers" and an authenticated HTTP Git server) and check the results with Git itself; Playwright end-to-end tests click through the actual app.
- **Secure by default:** sandboxed renderer without Node access, context isolation, strict Content Security Policy, schema-validated IPC, and Git can only be run on repositories you opened.

<br>

## License

GitBob is released under the [MIT License](LICENSE).

<br>

<p align="center">
  <img src="src/renderer/src/assets/logo.png" alt="" width="64"><br>
  <b>GitBob</b> · <a href="https://gitbob.app/">gitbob.app</a><br>
  <sub>Made with care for everyone who uses Git.</sub>
</p>

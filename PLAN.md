# Code Walk — Plan

Code Walk lets an AI assistant (Claude Code first) present a guided tour of code in a git repo — "give me a code walkthrough of this branch" — as a clean, locally served web page. A walk is a Markdown file whose code blocks are **git references, not copies**: the server resolves them against the repo at render time.

Goals:

- **LLM-first.** The reference syntax *is* `git show` / `git diff` arguments, so an LLM already knows it. A small CLI lets the LLM scaffold (`outline`) and verify (`check`) references instead of guessing.
- **No duplication.** Walks contain prose + references. Code and diffs come from git.
- **Unambiguous.** Every snippet states exactly what it shows: which repo, which file, and which side(s) — a commit, the index (staged), or the working tree.
- **Linkable.** Click / shift-click line numbers like GitHub. The URL is self-describing, so pasting it into a Claude prompt tells Claude exactly what code is meant, even though Claude can't open localhost.
- **Clean.** A basic, beautiful Markdown renderer with great syntax highlighting, readable diffs and Mermaid diagrams. Reviewing code should feel good.
- **Easy install** from the GitHub repo: an npm-installable CLI plus a Claude Code plugin that carries the skill.

Primary use case: **code review of committed changes** (branches, PRs, commits). Staged / working-tree references are supported for occasional use.

---

## 1. Walk file format

A walk is Markdown (CommonMark + GFM tables/strikethrough) with YAML frontmatter.

### Frontmatter

```yaml
---
title: Add rate limiting to the gateway
repos:              # optional; first entry is the default repo
  gateway: .        # paths relative to the walk file; ~ allowed
  sdk: ../client-sdk
---
```

- `repo: <path>` is shorthand for a single repo.
- With no `repo`/`repos`, the default repo is the git repo containing the walk file (else the directory `serve` was started in).

### `show` blocks — a file, or a commit

The info string is `git show` arguments, optionally followed by a line range.

| Block | Shows | Git equivalent |
|---|---|---|
| ` ```show a1b2c3d:src/x.ts L20-24 ` | file at a commit | `git show a1b2c3d:src/x.ts` |
| ` ```show main:src/x.ts ` | file at a branch tip | `git show main:src/x.ts` |
| ` ```show :src/x.ts ` | staged (index) version | `git show :src/x.ts` |
| ` ```show src/x.ts ` | working-tree file | `cat src/x.ts` |
| ` ```show a1b2c3d ` | whole commit: message + diff vs first parent | `git show a1b2c3d` |
| ` ```show a1b2c3d -- src/x.ts ` | one file's changes in a commit | `git show a1b2c3d -- src/x.ts` |

Refs are anything git resolves: hashes, branches, tags, `HEAD~2`, …

### `diff` blocks

| Block | Old side → new side | Git equivalent |
|---|---|---|
| ` ```diff main..feature -- src/x.ts ` | commit → commit | `git diff main..feature` |
| ` ```diff main...feature ` | merge-base → feature (what a PR shows) | `git diff main...feature` |
| ` ```diff a1b2c3d e4f5g6h -- src/x.ts ` | commit → commit | `git diff a1b2c3d e4f5g6h` |
| ` ```diff --cached -- src/x.ts ` | HEAD → staged | `git diff --cached` |
| ` ```diff --cached a1b2c3d -- src/x.ts ` | commit → staged | `git diff --cached a1b2c3d` |
| ` ```diff -- src/x.ts ` | staged → working tree | `git diff` |
| ` ```diff HEAD -- src/x.ts ` | HEAD → working tree | `git diff HEAD` |

- Without `-- <path>`, every changed file is shown, each with its own header.
- Multiple paths after `--` are allowed.
- Gotcha (same as git): bare `diff` is **staged → working tree**. Use `diff HEAD` for "all uncommitted changes".

### Summary blocks (`--stat`)

`--stat` on any `diff` or `show <commit>` renders a summary instead of code, as many times and wherever the walk wants:

- **Header:** side badges, the git command, file and commit counts, +/− totals, GitHub-style five-square change bar.
- **Rows:** status (A/M/D/R), path (links to the file's snippet if the walk shows it), per-file note, +/−, bar.
- **Groups (optional YAML body):** a list of `{ group, note?, files }`, where `files` is a glob, list of globs, or map of glob → per-file note. First matching group wins, `dir/` means everything under it, renames match by old or new path. Each group shows a subtotal; a Total row follows when there's more than one group. Unmatched files go to an automatic **Ungrouped** group so the summary always accounts for the whole diff.
- **Source of truth:** counts come from `git diff --numstat`, status and renames from `--name-status`, commits from `git log A..B`. Nothing is typed by hand.
- **`check`:** invalid group YAML is an error. Patterns that match no changed files are warnings (and are shown under the summary).

### Line selection (last token, optional)

- File blocks: `L20` or `L20-24` — show only those lines. The rest of the file stays one click away ("expand").
- Diff blocks (single file only):
  - `R30-35` — new-side lines 30–35, plus any deleted lines interleaved with them.
  - `L12-18` — old-side lines.
  - `L12-R14` — a span that crosses from the old side to the new side.
  - `hunk=2` — the 2nd hunk, numbered as `code-walk outline` prints them (3 lines of context, like git).
- Without a selection, a diff shows all hunks with 3 lines of context. Unchanged regions collapse into expandable "⋯ N unchanged lines" rows.

### Block options (block body, optional)

```
highlight: 22-24
```

Emphasizes lines inside the snippet. Numbers are new-side / file line numbers. Old side: `highlight: L12-13`.

### Multiple repos

Use git's own `-C` flag with a repo name from `repos:` (or a path relative to the walk file):

````md
```diff -C sdk main...feature -- src/retry.ts R10-30
```
````

No `-C` means the default repo.

### Mermaid

Standard ` ```mermaid ` blocks.

---

## 2. Viewer

- **Layout.** A single readable column (~760px) for prose. Code blocks can widen past it on large screens. On wide screens a sticky table of contents built from headings sits on the left. System fonts, generous whitespace, light/dark following the OS.
- **Highlighting.** Shiki (VS Code grammars) with GitHub light/dark themes. The whole file is always highlighted, then sliced, so grammar state is correct even mid-file.
- **Diffs.** Unified view with two line-number columns (old / new) and `+`/`-` markers. Word-level emphasis within modified lines. Unchanged stretches collapse into click-to-expand rows. Added / deleted / renamed / binary files are labeled.
- **Snippet header.** It states exactly what the lines are:
  - Line 1: repo name (only when the walk uses several repos, plain monospace label), path, and status (added / deleted / renamed from …).
  - Line 2: side badges — `● a1b2c3d main` (commit: solid dot, short sha plus ref name as written; hover shows full sha, subject, author, date), `◐ STAGED` (index), `○ WORKING TREE` (live). Diffs show `old → new`. On the right, the exact `git …` command that produces the snippet (copyable), with `-C <path>` when not the walk's own repo.
- **Commit blocks** (`show <sha>`) render a commit card (subject, body, author, date, sha) followed by file diffs.
- **Errors.** A bad reference renders an inline error box with the block source and git's message. The page never fails as a whole.
- **Line linking.**
  - Click a line number to select a line. Shift-click selects a range (a single range only).
  - In diffs, the column clicked decides the side (`L` old / `R` new).
  - The URL fragment updates as you select, and loading a URL with a selection scrolls to it and flashes it.
  - `y` or the 🔗 button copies the link. `Y` / shift-click 🔗 copies a prompt-friendly reference.
- **Live reload.** Saving the walk file reloads open pages (SSE).
- **Keyboard.**
  - `j` / `k` — next / previous section heading.
  - `y` / `Y` — copy link / prompt reference for the current selection.

### URL format

```
http://localhost:4747/w/<walk-name>#<git args with + for spaces>&<range>
```

Examples:

```
http://localhost:4747/w/ratelimit#show+a1b2c3d:src/gateway/limiter.ts&L20-24
http://localhost:4747/w/ratelimit#diff+9f8e7d6..e4f5g6h+--+src/gateway/router.ts&R30-35
http://localhost:4747/w/ratelimit#-C+sdk+diff+--cached+a1b2c3d+--+src/retry.ts&L12-R14
```

- Branch names are resolved to commit hashes when a link is copied, so links stay exact. Staged and working-tree references stay symbolic (there is nothing to pin).
- `-C <name>` appears when the walk uses several repos.
- The prompt-friendly copy adds context:

  ```
  src/gateway/limiter.ts @ a1b2c3d L20-24 (repo gateway = /abs/path; walk: .code-walk/ratelimit.md, section "Token bucket")
  http://localhost:4747/w/ratelimit#show+a1b2c3d:src/gateway/limiter.ts&L20-24
  ```

### Review comments

- **Leaving a comment.** Select lines and press `c` (or use **Comment** in the selection toolbar that appears at the bottom). An inline composer opens under the lines; ⌘↩ saves it.
- **Threads.** Threads render inline under the code they're attached to, with reply, edit, delete, resolve / reopen and copy-link actions.
  - Resolved threads collapse to one line.
  - Commented lines get a small dot in the gutter.
  - `n` / `p` jump between open threads.
- **What a comment stores.** The snippet's pinned link, range, path, repo, section and a copy of the selected lines. Claude sees the context without resolving anything.
  - A comment whose snippet is no longer in the walk is listed at the end of the page under "Comments on code no longer in this walk", with its quoted lines.
- **Storage.** `<walk>.comments.json` next to the walk. The server records served walks in `~/.code-walk/recent.json` (`CODE_WALK_HOME` overrides the location), so `code-walk comments` works from inside the repo with no arguments.
- **Live updates.** Changes from the CLI push to open pages over SSE without a reload, and drafts in progress are preserved.
- **Safety.** Write endpoints require JSON bodies and a same-origin `Origin` header.
- **Handoff to Claude.** The user says "address my code walk comments". Claude runs `code-walk comments`, makes the changes, and replies with `code-walk comments reply <id> "…" --resolve`.

---

## 3. CLI

`code-walk <command>` (Node ≥ 20):

| Command | Purpose |
|---|---|
| `serve <walk.md or dir> [--port 4747] [--open]` | Serve walks on 127.0.0.1 with live reload. A directory serves an index of its `.md` files. |
| `outline [-C <repo>] <diff args>` | List changed files, `+/-` counts, hunks (with `hunk=N` and line ranges) and commits, each as a ready-to-paste block line. The LLM scaffolds from this instead of guessing line numbers. |
| `check <walk.md>` | Resolve every reference. Print `file:line` errors (bad ref, missing path, range out of bounds, missing hunk). Exit 1 on failure. |
| `resolve <url> [--walk <file>]` | Print the code a Code Walk URL refers to, with line numbers and a little context. Asks the running server first, then falls back to resolving locally. |
| `comments [walk...] [--all] [--json]` | List review comments: id, file, range, section, the lines they're attached to, and the thread. Without a path, finds walks in `.code-walk/` and among walks recently served for the current repo. |
| `comments reply <id> <text> [--resolve]`, `comments resolve\|reopen <id>` | Claude answers and resolves comments. Open pages update live. |

---

## 4. Skill and install

- **`skills/code-walk/SKILL.md`** — short and example-first:
  - When to use it.
  - Workflow: `outline` → write walk → `check` → `serve --open`.
  - Syntax cheat sheet and one complete example walk.
  - How to read a pasted Code Walk URL.
  - Writing guidance: order by concept rather than file, open with a Mermaid overview for big changes, keep snippets focused, explain *why*.
- **The repo is a Claude Code plugin marketplace** (`.claude-plugin/marketplace.json`) containing a `code-walk` plugin with the skill.
- **Install:**

  ```bash
  npm install -g github:jeffbaumes/code-walk        # CLI
  claude plugin marketplace add jeffbaumes/code-walk
  claude plugin install code-walk@code-walk         # skill
  ```

  The skill falls back to `npx -y github:jeffbaumes/code-walk` when `code-walk` is not on PATH.

---

## 5. Architecture

- Plain modern JavaScript (ESM, no build step), so installing from GitHub just works.
- **Dependencies:**
  - `markdown-it` — markdown rendering.
  - `shiki` — syntax highlighting.
  - `mermaid` — served locally, works offline.
  - `yaml` — frontmatter.
  - `diff` — word-level emphasis.
- **`src/refs.js`** parses block info strings / URL fragments into a normalized reference. `{ kind: 'file' | 'diff' | 'commit', repo, sides, paths, selection }`, where a side is `{ type: 'commit', rev, sha } | { type: 'index' } | { type: 'worktree' }`.
- **`src/git.js`** handles git access:
  - `execFile` with argument arrays only. Refs are validated, and tokens beginning with `-` are rejected unless they are a known flag.
  - Blob reads use `git cat-file`, with caching for immutable (sha-addressed) content.
- **`src/diff.js`**:
  - Gets exact change regions from `git diff -U0` for each file between the normalized sides.
  - Builds full-file row lists (context + changes) from the two blobs, and groups hunks like `-U3`.
  - Applies selections.
- **`src/highlight.js`** — Shiki tokens (dual theme via CSS variables), language by extension, plain text fallback for huge or binary files.
- **`src/render.js`** — markdown-it with a fence override. References are resolved asynchronously first, then rendered to HTML.
- **`src/server.js`** — `node:http` server with routes for walks, static assets, SSE reload, and `/api/resolve`.
- **`web/`** — `app.css` and `app.js` (line selection, URLs, copy, expand, keyboard, mermaid init).
- **Security** — binds 127.0.0.1 only and never runs a shell.

---

## 6. Scope

### MVP (this build)

- Walk format: frontmatter, `repos`/`-C`, `show` (file at commit / index / worktree, commit), `diff` (all git side combinations above), line selections, `hunk=N`, `highlight:`.
- Viewer: Shiki highlighting, unified diffs with word-level emphasis, expandable unchanged regions, side badges + git command, commit cards, inline errors, Mermaid, TOC, light/dark.
- Line linking with self-describing URLs, `y`/`Y` copy, `j`/`k` navigation.
- Live reload of the walk file.
- CLI: `serve`, `outline`, `check`, `resolve`.
- Skill + plugin marketplace + README.
- Review comments: inline threads, selection toolbar, `comments` CLI with reply / resolve, live updates.
- `--stat` summary blocks with groups, notes, subtotals, totals, snippet links and `check` warnings.

### Later / candidates

- Split (side-by-side) diff toggle.
- Symbol anchors (`fn=createLimiter`) via tree-sitter.
- `pin`: snapshot staged / working-tree state into git objects (`git stash create`, kept under `refs/code-walk/*`) so non-commit references stay stable.
- Open-in-editor and "view on GitHub" links.
- Static HTML export for sharing.

### Explicitly out (for now)

- Review progress bar / reviewed checkboxes.
- A floating review / comment-count widget (inline threads plus `n`/`p` are enough).
- Drift markers / live-vs-snapshot views.
- Per-repo colors.

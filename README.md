# Code Walk

Guided code walkthroughs that reference git instead of copying code.

A walk is a Markdown file. Its code blocks are `git show` / `git diff` arguments, and `code-walk serve` renders them from the repo as a clean local web page, with syntax highlighting, readable diffs, Mermaid diagrams, and GitHub-style line links you can paste back into Claude.

It's built for AI assistants: ask Claude Code for "a code walkthrough of this branch" and it writes a short walk file and opens it for you.

````md
---
title: Per-client rate limiting
---

The router now checks a token bucket before dispatching.

```diff main...feature/rate-limit -- src/router.ts R14-19
```

```show feature/rate-limit:src/limiter.ts L26-35
highlight: 29-30
```
````

## Install

**The CLI** (Node ≥ 20):

```bash
npm install -g github:jeffbaumes/code-walk
```

**The Claude Code skill** (teaches Claude the format and workflow):

```bash
claude plugin marketplace add jeffbaumes/code-walk
```

```bash
claude plugin install code-walk@code-walk
```

If `code-walk` isn't on your PATH, the skill falls back to `npx -y github:jeffbaumes/code-walk`.

**Without the plugin system**, copy the skill directly:

```bash
mkdir -p ~/.claude/skills && cp -r skills/code-walk ~/.claude/skills/
```

## Try it

```bash
npm run demo
```

This builds a small demo repo (a feature branch, plus staged and unstaged edits) in your temp directory and serves a walk that uses every block type at http://localhost:4747.

## Usage

```
code-walk serve <walk.md|dir> [--port 4747] [--open]   Serve walks with live reload
code-walk outline [-C <repo>] [diff args]              Changed files + hunks in walk syntax
code-walk check <walk.md...>                           Verify every reference resolves
code-walk resolve <url> [--walk <walk.md>]             Print the code a Code Walk URL points at
```

- `serve` defaults to `.code-walk/` if it exists, otherwise the current directory. It binds to 127.0.0.1 only.
- `outline` defaults to `<default-branch>...HEAD`.

## Block reference

| Block | Shows |
|---|---|
| `show <rev>:<path> [L20-24]` | file at a commit |
| `show :<path>` | staged (index) file |
| `show <path>` | working-tree file |
| `show <commit> [-- <path>]` | commit message + diff vs first parent |
| `diff A..B` / `diff A B` `[-- <path>]` | commit → commit |
| `diff A...B [-- <path>]` | merge-base → B (what a PR shows) |
| `diff --cached [A] [-- <path>]` | A (default HEAD) → staged |
| `diff A [-- <path>]` | A → working tree |
| `diff [-- <path>]` | staged → working tree |

**Summaries:** add `--stat` to a `diff` or `show <commit>` block to render files, +/− counts, change bars and totals, computed from git on every render. The optional YAML body groups files, with a note per group and per file, and a subtotal per group. Files no group matches go to **Ungrouped**. Use as many summaries as you like.

````md
```diff --stat main...feature
- group: Backend
  note: Token bucket and its wiring
  files:
    src/limiter.ts: New in-memory token bucket
    src/**: Other server changes
- group: Tests
  files: [test/]
```
````

**Line selection** is the last token:
- File blocks take `L20` or `L20-24`.
- Single-file diffs take `R30-35` (new side), `L12-18` (old side), `L12-R14` (a span across sides), or `hunk=N`.

**Block options** go in the block body: `highlight: 22-24` (use `L12-13` for the old side).

**Multiple repos:** declare them in frontmatter and pick one per block with `-C <name>`. The first repo listed is the default.

```yaml
---
repos:
  gateway: .
  sdk: ../client-sdk
---
```

**Mermaid:** standard ` ```mermaid ` blocks.

## Links

- **Selecting lines:** click a line number to select it. Shift-click selects a range.
- **The URL** updates to a self-describing reference, so it makes sense without the server:

  ```
  http://localhost:4747/w/rate-limit#diff+2b88ce2dbf1f..de7efebec33f+--+src/router.ts&L14-R19
  ```

- **Branch names are pinned** to commit hashes in links.
- **Copying:**
  - `y` or the 🔗 button copies the link.
  - `Y` or shift-🔗 copies a prompt-ready reference that includes the repo path.
- **Navigation:** `j` / `k` jump between sections.

## Review comments

**Leaving comments in the page:**
- Select lines and press `c`, or use **Comment** in the selection toolbar.
- Comments are threaded under the code. You can reply to them, and edit, resolve, reopen or delete them.
- `n` / `p` jump between open comments.

**Handing off to Claude:** tell Claude "address my code walk comments". Claude then:
1. Runs `code-walk comments` to get each open comment with its file, line range, section and the exact lines it's attached to.
2. Makes the changes.
3. Replies to each comment with `code-walk comments reply <id> "…" --resolve`.

Replies appear in the open page immediately.

**Storage:**
- Comments are saved next to the walk as `<walk>.comments.json`.
- `code-walk serve` also records served walks in `~/.code-walk/recent.json`. That's how `code-walk comments` run inside a repo finds the right walk without being given a path.

```
code-walk comments [<walk.md>...] [--all] [--json]
code-walk comments reply <id> <text> [--resolve]
code-walk comments resolve|reopen <id>
code-walk comments add --walk <walk.md> "<ref> <range>" <text>
code-walk comments edit <id> [--reply <id>] --old <text> --new <text>
```

## Development

```bash
npm install
```

```bash
npm test
```

See [PLAN.md](PLAN.md) for the design and roadmap.

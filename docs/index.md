---
title: Code Walk
---

> 📖 **Code Walk** — a guided tour whose code is git references, so this file looks sparse as plain text. To view it, run `npx -y github:jeffbaumes/code-walk serve docs/index.md` ([code-walk](https://github.com/jeffbaumes/code-walk)), or read it rendered at [jeffbaumes.github.io/code-walk](https://jeffbaumes.github.io/code-walk/).

**Guided code walkthroughs that point at git instead of pasting code.** A walk is a Markdown file whose code blocks are `git show` and `git diff` arguments. Code Walk resolves them against the repo and renders a clean page with syntax highlighting, readable diffs, collapsible context, line links and review comments.

It's built for working with AI assistants. Ask Claude Code for "a walkthrough of this branch" and it writes a short walk and opens it in your browser. You read it, leave comments on the lines you have questions about, and Claude answers them in place.

**This page is a code walk.** Every snippet below is a git reference into the [code-walk repo](https://github.com/jeffbaumes/code-walk), and a workflow renders the page with `code-walk build` on every push. Its source is [docs/index.md](https://github.com/jeffbaumes/code-walk/blob/main/docs/index.md).

## Get started

Install the CLI (Node 20 or newer):

```bash
npm install -g github:jeffbaumes/code-walk
```

Then add the Claude Code plugin, which teaches Claude the format and the review workflow:

```bash
claude plugin marketplace add jeffbaumes/code-walk
claude plugin install code-walk@code-walk
```

Now ask Claude for a tour of a branch, a PR, a commit, or "how does X work". To see every block type in a sample repo first, clone this repo and run `npm run demo`.

## A walk is Markdown with git references

Here's the kind of file Claude writes. Prose explains; each fenced block names code by commit and path instead of copying it:

````md
---
title: How references are found
---

Any fenced block whose info string starts with `show` or `diff` is a git reference.

```show 5c288d0:src/render.js L16-19
```
````

`code-walk serve` renders that block from the repo, like this:

```show 5c288d0:src/render.js L16-19
```

Because the code comes from git, a walk can't drift from the code it describes. Branch names are pinned to commits in links, and a walk about a branch still renders after the branch moves.

Each reference is resolved in parallel while the Markdown is parsed. Errors don't break the page: a block that can't be resolved shows the error in its place, and `code-walk check` reports it with a line number.

```show 5c288d0:src/render.js L68-92
highlight: 70-87
```

The collapsed bars above and below are the rest of the file. Click one to expand it, and click again to hide it.

## Diffs

`diff` takes the same arguments as `git diff`: two commits, a range, `main...feature` for what a PR shows, `--cached` for staged changes, or nothing for your working tree. Here's the change that turned comment markers into a bar down the gutter:

```diff a031379 5c288d0 -- web/app.css
```

Pick part of a diff with `hunk=N`, or with line ranges on the old (`L`) or new (`R`) side. Here's the hunk where a walk's `repo:` learned to accept a git URL:

```diff 64b543f 9728c9e -- src/walk.js hunk=3
```

## Commits

`show <commit>` renders the commit message, author and date above its diff. Add `-- <path>` to narrow it to some files:

```show 5c288d0 -- web/app.js
```

## Summaries

Add `--stat` for an overview: files, +/− counts and change bars, computed from git on every render. An optional YAML body sorts the files into groups with notes. This is the first feature release of Code Walk:

```diff --stat 64b543f 9728c9e
- group: Remote repos
  note: Walks can reference a repo by git URL
  files:
    src/remote.js: Bare clones in a cache dir, fetched once per run
    src/walk.js: "`repo:` accepts a URL"
    src/git.js: ""
    src/resolve.js: ""
    src/stats.js: ""
- group: Viewer
  files: [web/, src/render.js]
- group: Docs and tests
  files: [README.md, skills/, test/, scripts/, src/commands/]
```

## Lines and links

Click a line number to select it, and shift-click to select a range. The address bar updates to a link that describes the code on its own. Paste it into Claude, and Claude can read exactly those lines with `code-walk resolve`:

```
https://jeffbaumes.github.io/code-walk/#show+5c288d0872eb:src/refs.js&L21-24
```

Try it on this snippet, which parses those selections:

```show 5c288d0:src/refs.js L21-37
highlight: 27-29
```

| Key | Does |
|---|---|
| `j` / `k` | Next / previous section |
| `y` | Copy a link to the selected lines (or the snippet) |
| `Y` | Copy a prompt-ready reference, including the command and repo |
| `c` | Comment on the selected lines (with `code-walk serve`) |
| `n` / `p` | Next / previous open comment |
| `Esc` | Clear the selection |

## Review comments

With `code-walk serve`, select lines and press `c` to leave a comment. Comments are threaded under the code and saved next to the walk in `<walk>.comments.json`.

When you're done reading, tell Claude "address my code walk comments". It runs `code-walk comments` to get each open thread with the exact lines it's attached to, makes the changes, and replies with `code-walk comments reply <id> "…" --resolve`. Replies show up in the open page right away.

A published page (like this one) shows its comments read-only. Here's a thread from that comment-marker change:

```diff a031379 5c288d0 -- web/app.js hunk=2
```

## Publish a walk

`code-walk build` renders a walk to a single self-contained HTML file, with the styles and scripts inline and no server needed. Existing comments are included read-only; pass `--no-comments` to leave them out. Given a directory, it builds every walk in it plus an index page.

```bash
code-walk build docs/index.md -o docs/index.html
```

That's the command behind this page: a [GitHub Actions workflow](https://github.com/jeffbaumes/code-walk/blob/main/.github/workflows/pages.yml) runs it on every push to `main` and publishes the result to GitHub Pages, so only the walk is checked in.

## Reference

| Block | Shows |
|---|---|
| `show <rev>:<path> [L20-24]` | A file at a commit |
| `show :<path>` / `show <path>` | The staged file / the working-tree file |
| `show <commit> [-- <path>]` | A commit's message and diff |
| `diff A..B` / `diff A B` | Commit to commit |
| `diff A...B` | Merge base to B (what a PR shows) |
| `diff --cached [A]` / `diff [A]` / `diff` | To staged / to working tree / staged to working tree |
| `… --stat` | A summary, optionally grouped |

Options go in the block body (`highlight: 22-24`). A walk can span several repos, local or by git URL, and can include Mermaid diagrams. The [README](https://github.com/jeffbaumes/code-walk#readme) has the details.

```
code-walk serve <walk.md|dir> [--open]       Serve walks with live reload and comments
code-walk build <walk.md|dir> [-o <out>]     Render to static HTML
code-walk check <walk.md...>                 Verify every reference resolves
code-walk outline [diff args]                Changed files and hunks, in walk syntax
code-walk comments [reply|resolve|add|edit]  Read and answer review comments
```

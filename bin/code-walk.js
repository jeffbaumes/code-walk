#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { startServer } from '../src/server.js';
import { checkCommand } from '../src/commands/check.js';
import { outlineCommand } from '../src/commands/outline.js';
import { resolveCommand } from '../src/commands/resolve.js';
import { commentsCommand } from '../src/commands/comments.js';
import { buildCommand } from '../src/commands/build.js';

const HELP = `code-walk — git-referenced code walkthroughs

Usage:
  code-walk serve <walk.md|dir> [--port 4747] [--open]   Serve walks with live reload
  code-walk build <walk.md|dir> [-o <out>] [--no-comments]
                                                         Render to self-contained static HTML
                                                         (a file → <name>.html; a dir → code-walk-html/)
  code-walk outline [-C <repo>] [diff args]              Changed files + hunks in walk syntax
                                                         (default: <default-branch>...HEAD)
  code-walk check <walk.md...>                           Verify every reference resolves
  code-walk resolve <url> [--walk <walk.md>]             Print the code a Code Walk URL points at
  code-walk comments [<walk.md>...] [--all] [--json]     List review comments left in the browser
  code-walk comments reply <id> <text> [--resolve]       Reply to a comment (as Claude)
  code-walk comments resolve|reopen <id>
  code-walk comments edit <id> [--reply <id>] --old <text> --new <text>   Replace text in a comment or reply
  code-walk comments add --walk <walk.md> "<ref> <range>" <text>   Start a comment thread (as Claude)

Block syntax (info string of a fenced block):
  show <rev>:<path> [L20-24]      file at a commit       show :<path>   staged file
  show <path>                     working-tree file      show <commit> [-- <path>]
  diff A..B | A...B | A B [-- <path>] [R30-35 | L12-18 | L12-R14 | hunk=N]
  diff --cached [A] / diff [A] (vs working tree) / diff (staged → working tree)
  diff --stat … / show --stat <commit>   summary: files, +/− and totals; body = YAML groups
  -C <repo-name>                  pick a repo from the frontmatter "repos:" map
`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

function bool(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  switch (cmd) {
    case 'serve': {
      const port = Number(flag(args, '--port') ?? flag(args, '-p') ?? 4747);
      const open = bool(args, '--open');
      const target = args[0] ?? (existsSync('.code-walk') ? '.code-walk' : '.');
      startServer({
        target,
        port,
        onListen: ({ url }) => {
          console.log(`Code Walk serving ${target} at ${url}`);
          if (open) {
            const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
            spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
          }
        },
      });
      return;
    }
    case 'build': {
      const out = flag(args, '--out') ?? flag(args, '-o');
      const comments = !bool(args, '--no-comments');
      const target = args[0] ?? (existsSync('.code-walk') ? '.code-walk' : null);
      if (!target) throw new Error('usage: code-walk build <walk.md|dir> [-o <out>] [--no-comments]');
      process.exitCode = await buildCommand(target, { out, comments });
      return;
    }
    case 'check':
      if (!args.length) throw new Error('usage: code-walk check <walk.md...>');
      process.exitCode = await checkCommand(args);
      return;
    case 'outline':
      process.stdout.write(await outlineCommand(args));
      return;
    case 'comments':
      process.stdout.write(await commentsCommand(args));
      return;
    case 'resolve': {
      const walk = flag(args, '--walk');
      if (!args[0]) throw new Error('usage: code-walk resolve <url> [--walk <walk.md>]');
      process.stdout.write(await resolveCommand(args[0], { walk }));
      return;
    }
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return;
    case '-v':
    case '--version': {
      const { createRequire } = await import('node:module');
      console.log(createRequire(import.meta.url)('../package.json').version);
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(`code-walk: ${e.message}`);
  process.exit(2);
});

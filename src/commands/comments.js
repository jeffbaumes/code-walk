// `code-walk comments`: list review comments left in the browser; reply to and resolve them.
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { EditConflictError, addComment, addReply, loadComments, replaceInComment, readRegistry, setStatus, sidecarPath } from '../comments.js';
import { repoRoot } from '../git.js';
import { formatSelection, parseRef } from '../refs.js';
import { prepareWalk } from '../render.js';
import { resolveRef } from '../resolve.js';
import { selectionSpan, splitLines } from '../rows.js';
import { loadWalk } from '../walk.js';

const USAGE = `usage:
  code-walk comments [<walk.md>...] [--all] [--json]     list open comments (--all includes resolved)
  code-walk comments reply <id> <text> [--resolve]      reply (as Claude) and optionally resolve
  code-walk comments resolve <id> | reopen <id>
  code-walk comments edit <id> [--reply <reply-id>] --old <text> --new <text>   replace text (--old must match exactly once)
  code-walk comments add --walk <walk.md> "<show|diff ref> <range>" <text>   start a thread (as Claude)
Without a walk path, walks are found in ./.code-walk/ and among walks recently served for this repo.`;

async function walksUnder(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory() && ent.name !== 'node_modules' && ent.name !== '.git') await walksUnder(p, out);
    else if (ent.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function within(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

/** Candidate walks for the current directory, most relevant first. */
async function candidateWalks({ anyRepo = false } = {}) {
  const cwd = process.cwd();
  const root = await repoRoot(cwd);
  const found = [];
  const add = (p) => { if (existsSync(p) && !found.includes(p)) found.push(p); };
  for (const p of await walksUnder(path.join(root || cwd, '.code-walk'))) add(p);
  const registry = await readRegistry();
  for (const w of registry) {
    const repos = Array.isArray(w.repos) ? w.repos : [];
    if (anyRepo || (root && repos.some((r) => within(root, r) || within(r, root))) || within(w.walkPath, cwd)) add(w.walkPath);
  }
  if (!found.length && registry.length) add(registry[0].walkPath);
  return found;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args.splice(i, 2)[1];
}

async function findComment(id, walkOpt) {
  const walks = walkOpt ? [path.resolve(walkOpt)] : await candidateWalks({ anyRepo: true });
  const hits = [];
  for (const w of walks) {
    const { comments } = await loadComments(w);
    for (const c of comments) if (c.id === id || c.id.startsWith(id)) hits.push({ walk: w, comment: c });
  }
  if (!hits.length) throw new Error(`no comment with id "${id}"${walkOpt ? '' : ' (pass --walk <walk.md> if it lives elsewhere)'}`);
  if (hits.length > 1) throw new Error(`comment id "${id}" matches ${hits.length} comments; pass --walk or a longer id`);
  return hits[0];
}

export async function commentsCommand(argv) {
  const args = [...argv];
  const sub = args[0];

  if (sub === 'reply' || sub === 'resolve' || sub === 'reopen') {
    args.shift();
    const walkOpt = option(args, '--walk');
    const author = option(args, '--author') || 'Claude';
    const resolve = flag(args, '--resolve');
    const id = args.shift();
    if (!id) throw new Error(USAGE);
    const { walk } = await findComment(id, walkOpt);
    let c;
    if (sub === 'reply') {
      const body = args.join(' ');
      if (!body.trim()) throw new Error('reply text is empty');
      c = await addReply(walk, id, { body, author, resolve });
    } else {
      c = await setStatus(walk, id, sub === 'resolve' ? 'resolved' : 'open');
    }
    return `${sub === 'reply' ? 'Replied to' : sub === 'resolve' ? 'Resolved' : 'Reopened'} ${c.id}${sub === 'reply' && resolve ? ' and resolved it' : ''} (${c.status}) in ${sidecarPath(walk)}\n`;
  }

  if (sub === 'edit') {
    args.shift();
    const walkOpt = option(args, '--walk');
    const replyId = option(args, '--reply');
    const oldText = option(args, '--old');
    const newText = option(args, '--new');
    const id = args.shift();
    if (!id || oldText === undefined || newText === undefined || args.length) {
      throw new Error('usage: code-walk comments edit <id> [--reply <reply-id>] --old <exact current text> --new <replacement>');
    }
    const { walk } = await findComment(id, walkOpt);
    try {
      const c = await replaceInComment(walk, id, oldText, newText, replyId || null);
      return `Edited ${replyId ? `reply ${replyId} on ` : ''}${c.id} in ${sidecarPath(walk)}\n`;
    } catch (e) {
      if (e instanceof EditConflictError) throw new Error(`${e.message}. Nothing was changed. Current text:\n---\n${e.current}\n---`);
      throw e;
    }
  }

  if (sub === 'add') {
    args.shift();
    const walkOpt = option(args, '--walk');
    const author = option(args, '--author') || 'Claude';
    if (!walkOpt) throw new Error('comments add needs --walk <walk.md>');
    const refStr = args.shift();
    const body = args.join(' ');
    if (!refStr || !body.trim()) throw new Error('usage: code-walk comments add --walk <walk.md> "<show|diff ref> <L/R range>" <text>');
    const c = await addCommentFromRef(path.resolve(walkOpt), refStr, body, author);
    return `Added ${c.comment.id} on ${c.comment.anchor.path} ${c.comment.anchor.range}${c.section ? ` (section "${c.section}")` : ''}${c.inWalk ? '' : '\nwarning: no snippet in the walk shows these lines, so it will be listed at the end of the page'}\n`;
  }

  if (sub === 'help' || sub === '--help' || sub === '-h') return USAGE + '\n';

  const all = flag(args, '--all');
  const json = flag(args, '--json');
  const walks = args.length ? args.map((a) => path.resolve(a)) : await candidateWalks();
  if (!walks.length) return 'No walks found. Pass a walk path: code-walk comments <walk.md>\n';

  const report = [];
  for (const w of walks) {
    const { comments } = await loadComments(w);
    const shown = comments.filter((c) => all || c.status !== 'resolved');
    if (shown.length) report.push({ walk: w, comments: shown, total: comments.length });
  }
  if (json) return JSON.stringify(report, null, 2) + '\n';
  if (!report.length) {
    return `No ${all ? '' : 'open '}comments in ${walks.length === 1 ? walks[0] : `${walks.length} walks`}.\n`;
  }
  const out = [];
  for (const { walk, comments } of report) {
    out.push(`# ${path.basename(walk)} — ${comments.length} ${all ? '' : 'open '}comment${comments.length === 1 ? '' : 's'}`);
    out.push(`walk: ${walk}`);
    for (const c of comments) out.push('', ...formatComment(c));
    out.push('');
  }
  out.push('Reply: code-walk comments reply <id> "<what you changed>" --resolve');
  return out.join('\n') + '\n';
}

/**
 * Anchor a new comment exactly like the browser does: resolve the reference, pin it to the
 * snippet's canonical link, copy the selected lines, and find the walk section showing it.
 */
async function addCommentFromRef(walkPath, refStr, body, author) {
  const ref = parseRef(refStr);
  if (!ref.selection || ref.selection.type !== 'range') {
    throw new Error('the reference needs a line range as its last token, e.g. R14-16, L8-11 or L12-R14');
  }
  const walk = await loadWalk(walkPath);
  const result = await resolveRef(walk, ref, { tokens: false });
  const s = result.sections[0];
  const oldLines = splitLines(s.oldText || '');
  const newLines = splitLines(s.newText || '');
  const lines = s.rows.slice(s.span.start, s.span.end).map((r) => ({
    o: s.mode === 'diff' ? r.o : null,
    n: r.n,
    t: r.t,
    text: (r.t === '-' ? oldLines[r.o - 1] : newLines[r.n - 1]) ?? '',
  }));
  const link = s.linkTokens.join(' ');

  // Which section of the walk shows this snippet (and does it show these lines at all)?
  const prepared = await prepareWalk(walk, { highlight: false });
  let heading = null;
  let section = null;
  let inWalk = false;
  for (let i = 0; i < prepared.tokens.length && !inWalk; i++) {
    const t = prepared.tokens[i];
    if (t.type === 'heading_open') heading = prepared.tokens[i + 1].content;
    const shown = t.type === 'fence' && t.meta?.result?.sections.find((x) => x.linkTokens.join(' ') === link);
    if (!shown) continue;
    try {
      selectionSpan(shown.rows, ref.selection, shown);
      inWalk = true;
      section = heading;
    } catch { /* lines not in this snippet */ }
  }

  const comment = await addComment(walkPath, {
    author,
    body,
    anchor: {
      link, range: formatSelection(ref.selection), path: s.path, mode: s.mode,
      repo: result.repo.root, repoName: result.repo.name, command: link, section, lines,
    },
  });
  return { comment, section, inWalk };
}

function formatComment(c) {
  const a = c.anchor;
  const out = [];
  const where = a ? [a.path, a.range, a.section && `section "${a.section}"`].filter(Boolean).join(' · ') : 'general';
  out.push(`## [${c.id}] ${where}${c.status === 'resolved' ? ' (resolved)' : ''}`);
  if (a) {
    if (a.repo && a.command) out.push(`code: git -C ${a.repo} ${a.command.replace(/^-C \S+ /, '')}`);
    if (a.lines?.length) {
      const w = Math.max(...a.lines.map((l) => String(Math.max(l.o || 0, l.n || 0)).length));
      for (const l of a.lines) {
        if (a.mode === 'diff') out.push(`  ${String(l.o ?? '').padStart(w)} ${String(l.n ?? '').padStart(w)} ${l.t} ${l.text}`);
        else out.push(`  ${String(l.n ?? '').padStart(w)} | ${l.text}`);
      }
    }
  }
  out.push(`${c.author} (${when(c.created)}): ${indent(c.body)}`);
  for (const r of c.replies || []) out.push(`  ↳ [${r.id}] ${r.author} (${when(r.created)}): ${indent(r.body, '    ')}`);
  return out;
}

function when(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function indent(text, pad = '  ') {
  return text.split('\n').join(`\n${pad}`);
}

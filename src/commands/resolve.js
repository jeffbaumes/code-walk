// `code-walk resolve <url>`: print the code a Code Walk URL points at.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { decodeFragment, parseRef, formatSelection } from '../refs.js';
import { resolveRef } from '../resolve.js';
import { loadWalk, walkFromSource } from '../walk.js';
import { splitLines } from '../rows.js';

const CONTEXT = 3;

export async function resolveUrlText(input, { walkPath = null, cwd = process.cwd() } = {}) {
  const { tokens, selection } = decodeFragment(input);
  if (!tokens.length) throw new Error('the URL has no #fragment describing a reference');
  const ref = parseRef(tokens);
  ref.selection = selection;
  const walk = walkPath ? await loadWalk(walkPath, { fallbackDir: cwd }) : await walkFromSource('', null, { fallbackDir: cwd });
  const result = await resolveRef(walk, ref, { tokens: false });
  return formatResultText(result);
}

export function formatResultText(result) {
  const out = [];
  for (const s of result.sections) {
    out.push(`$ ${s.displayCmd}`);
    out.push(`repo: ${result.repo.name} (${result.repo.root})`);
    if (result.kind === 'commit' && result.commit) out.push(`commit: ${result.commit.sha} ${result.commit.subject}`);
    if (s.mode === 'diff') {
      out.push(`old (L): ${sideText(s.sides[0])}${s.oldPath ? `  ${s.oldPath}` : '  (file absent)'}`);
      out.push(`new (R): ${sideText(s.sides[1])}${s.newPath ? `  ${s.newPath}` : '  (file absent)'}`);
    } else {
      out.push(`file: ${s.path} @ ${sideText(s.sides[0])}`);
    }
    if (result.ref.selection) out.push(`selected: ${formatSelection(result.ref.selection)} (marked with ">")`);
    out.push('');
    if (s.binary) { out.push('(binary file)'); continue; }

    const oldLines = splitLines(s.oldText || '');
    const newLines = splitLines(s.newText || '');
    let windows;
    if (s.span) windows = [{ start: Math.max(0, s.span.start - CONTEXT), end: Math.min(s.rows.length, s.span.end + CONTEXT) }];
    else if (s.mode === 'diff') windows = s.hunks;
    else windows = [{ start: 0, end: s.rows.length }];

    const w = String(s.rows.length ? Math.max(...s.rows.map((r) => Math.max(r.o || 0, r.n || 0))) : 1).length;
    windows.forEach((win, wi) => {
      if (wi > 0) out.push(' ...');
      for (let i = win.start; i < win.end; i++) {
        const r = s.rows[i];
        const sel = s.span && i >= s.span.start && i < s.span.end ? '>' : ' ';
        if (s.mode === 'file') {
          out.push(`${sel} ${String(r.n).padStart(w)} | ${newLines[r.n - 1] ?? ''}`);
        } else {
          const text = r.t === '-' ? oldLines[r.o - 1] : newLines[r.n - 1];
          out.push(`${sel} ${String(r.o ?? '').padStart(w)} ${String(r.n ?? '').padStart(w)} ${r.t} ${text ?? ''}`);
        }
      }
    });
    out.push('');
  }
  return out.join('\n');
}

function sideText(side) {
  if (side.type === 'index') return 'staged index';
  if (side.type === 'worktree') return 'working tree';
  const rev = side.rev && !side.sha.startsWith(side.rev) ? ` (${side.rev})` : '';
  return `${side.sha.slice(0, 12)}${rev}`;
}

export async function resolveCommand(url, { walk: walkOpt } = {}) {
  let parsed = null;
  try { parsed = new URL(url); } catch { /* bare fragment */ }
  const walkName = parsed && parsed.pathname.startsWith('/w/') ? decodeURIComponent(parsed.pathname.slice(3)) : null;

  // Ask the server that produced the URL, if it's still running.
  if (parsed && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname) && !walkOpt) {
    try {
      const api = new URL('/api/resolve', parsed.origin);
      if (walkName) api.searchParams.set('walk', walkName);
      api.searchParams.set('frag', parsed.hash.slice(1));
      const res = await fetch(api, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return res.text();
    } catch { /* fall back to local resolution */ }
  }

  let walkPath = walkOpt || null;
  if (!walkPath && walkName) {
    for (const candidate of [path.join('.code-walk', `${walkName}.md`), `${walkName}.md`]) {
      if (existsSync(candidate)) { walkPath = candidate; break; }
    }
  }
  return resolveUrlText(parsed ? parsed.hash : url, { walkPath });
}

// Turn a parsed reference into renderable sections: sides, rows, hunks, tokens.
import path from 'node:path';
import {
  EMPTY_TREE, GitError, changeRegions, changedFiles, commitInfo, firstParent, mergeBase, readSide,
  resolveCommit, tryResolveCommit,
} from './git.js';
import { RefError } from './refs.js';
import { diffRows, fileRows, groupHunks, parseHighlight, selectionSpan, splitLines } from './rows.js';
import { highlightLines, langForPath } from './highlight.js';
import { repoDirArg, resolveRepo } from './walk.js';

async function commitSide(root, rev, label = rev) {
  const sha = await resolveCommit(root, rev);
  const info = await commitInfo(root, sha);
  return { type: 'commit', rev: label, sha, short: sha.slice(0, 7), info };
}

function isShaLike(rev, sha) {
  return rev && /^[0-9a-f]{4,40}$/i.test(rev) && sha.startsWith(rev.toLowerCase());
}

function normPath(p) {
  return p.replace(/^\.\//, '');
}

function isBinary(buf) {
  if (!buf) return false;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function describeSide(side) {
  if (side.type === 'commit') return isShaLike(side.rev, side.sha) ? side.short : `${side.rev} (${side.short})`;
  return side.type === 'index' ? 'the staged index' : 'the working tree';
}

/**
 * Parse block options from the fence body (`key: value` lines).
 */
export function parseOptions(body) {
  const opts = {};
  for (const line of String(body || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([a-z][\w-]*)\s*:\s*(.*)$/i.exec(t);
    if (!m) throw new RefError(`unrecognized block option line "${t}" (supported: highlight: 22-24)`);
    const key = m[1].toLowerCase();
    if (key !== 'highlight') throw new RefError(`unknown block option "${m[1]}" (supported: highlight)`);
    opts.highlight = parseHighlight(m[2]);
  }
  return opts;
}

export async function resolveRef(walk, ref, { options = {}, tokens = true } = {}) {
  const repo = await resolveRepo(walk, ref.repo);
  const { root } = repo;
  const result = { ref, repo, kind: null, commit: null, sections: [] };

  if (ref.command === 'show') {
    const target = ref.target;
    const colon = target.indexOf(':');
    if (colon !== -1) {
      if (ref.paths.length) throw new RefError('use either <rev>:<path> or <commit> -- <path>, not both');
      const rev = target.slice(0, colon);
      const file = normPath(target.slice(colon + 1));
      if (!file) throw new RefError(`missing path after ":" in "${target}"`);
      const side = rev === '' ? { type: 'index' } : await commitSide(root, rev);
      result.kind = 'file';
      result.sections.push(await fileSection(root, side, file));
    } else {
      const sha = ref.paths.length ? await resolveCommit(root, target) : await tryResolveCommit(root, target);
      if (sha) {
        result.kind = 'commit';
        const newSide = await commitSide(root, target);
        result.commit = newSide.info;
        const parent = await firstParent(root, sha);
        const oldSide = parent
          ? { type: 'commit', rev: `${target}^`, sha: parent, short: parent.slice(0, 7), info: await commitInfo(root, parent) }
          : { type: 'commit', rev: '(root)', sha: EMPTY_TREE, short: 'empty', info: await commitInfo(root, EMPTY_TREE) };
        result.sections = await diffSections(root, oldSide, newSide, ref.paths.map(normPath));
      } else {
        const file = normPath(target);
        result.kind = 'file';
        const side = { type: 'worktree' };
        const buf = await readSide(root, side, file);
        if (!buf) throw new GitError(`"${target}" is neither a commit nor a file in the working tree of ${repo.name}`);
        result.sections.push(await fileSection(root, side, file, buf));
      }
    }
  } else {
    result.kind = 'diff';
    const [oldSide, newSide] = await diffSides(root, ref);
    result.sections = await diffSections(root, oldSide, newSide, ref.paths.map(normPath));
    if (!result.sections.length) {
      throw new GitError(`no changes between ${describeSide(oldSide)} and ${describeSide(newSide)}${ref.paths.length ? ` in ${ref.paths.join(', ')}` : ''}`);
    }
  }

  if (ref.selection) {
    if (result.sections.length !== 1) {
      throw new RefError(`a line selection needs exactly one file, but this shows ${result.sections.length}; add "-- <path>"`);
    }
    const s = result.sections[0];
    s.span = selectionSpan(s.rows, ref.selection, s);
  }
  for (const s of result.sections) {
    s.highlight = options.highlight || null;
    s.linkTokens = linkTokens(walk, repo, result, s);
    s.displayCmd = displayCommand(repo, result, s);
    if (tokens) await addTokens(s);
  }
  return result;
}

/** Old and new side of `show <commit>`: the first parent (or the empty tree) and the commit. */
export async function commitSides(root, target) {
  const newSide = await commitSide(root, target);
  const parent = await firstParent(root, newSide.sha);
  const oldSide = parent
    ? { type: 'commit', rev: `${target}^`, sha: parent, short: parent.slice(0, 7), info: await commitInfo(root, parent) }
    : { type: 'commit', rev: '(root)', sha: EMPTY_TREE, short: 'empty', info: await commitInfo(root, EMPTY_TREE) };
  return [oldSide, newSide];
}

export async function diffSides(root, ref) {
  const { revs, cached } = ref;
  if (revs.length === 0) {
    return cached ? [await commitSide(root, 'HEAD'), { type: 'index' }] : [{ type: 'index' }, { type: 'worktree' }];
  }
  if (revs.length === 2) return [await commitSide(root, revs[0]), await commitSide(root, revs[1])];
  const rev = revs[0];
  if (rev.includes('...')) {
    const [a, b] = rev.split('...');
    const left = await commitSide(root, a || 'HEAD');
    const right = await commitSide(root, b || 'HEAD');
    const base = await mergeBase(root, left.sha, right.sha);
    const info = await commitInfo(root, base);
    return [{ type: 'commit', rev: `merge-base(${a || 'HEAD'}, ${b || 'HEAD'})`, sha: base, short: base.slice(0, 7), info, mergeBase: true }, right];
  }
  if (rev.includes('..')) {
    const [a, b] = rev.split('..');
    return [await commitSide(root, a || 'HEAD'), await commitSide(root, b || 'HEAD')];
  }
  return [await commitSide(root, rev), cached ? { type: 'index' } : { type: 'worktree' }];
}

async function fileSection(root, side, file, buf) {
  buf ??= await readSide(root, side, file);
  if (!buf) throw new GitError(`${file} does not exist in ${describeSide(side)}`);
  const binary = isBinary(buf);
  const text = binary ? '' : buf.toString('utf8');
  const lines = splitLines(text);
  return {
    mode: 'file', path: file, oldPath: null, status: null, sides: [side], binary,
    lang: langForPath(file), newText: text, oldText: null, rows: fileRows(lines.length), hunks: [], span: null,
  };
}

async function diffSections(root, oldSide, newSide, paths) {
  const files = await changedFiles(root, oldSide, newSide, paths);
  return Promise.all(files.map(async (f) => {
    const [oldBuf, newBuf, { regions, binary: gitBinary }] = await Promise.all([
      f.oldPath ? readSide(root, oldSide, f.oldPath) : null,
      f.newPath ? readSide(root, newSide, f.newPath) : null,
      changeRegions(root, oldSide, newSide, f),
    ]);
    const binary = gitBinary || isBinary(oldBuf) || isBinary(newBuf);
    const oldText = binary || !oldBuf ? '' : oldBuf.toString('utf8');
    const newText = binary || !newBuf ? '' : newBuf.toString('utf8');
    const rows = binary ? [] : diffRows(splitLines(oldText), splitLines(newText), regions);
    let added = 0;
    let removed = 0;
    for (const r of rows) { if (r.t === '+') added++; else if (r.t === '-') removed++; }
    return {
      mode: 'diff', path: f.newPath || f.oldPath, oldPath: f.oldPath, newPath: f.newPath, status: f.status,
      sides: [oldSide, newSide], binary, lang: langForPath(f.newPath || f.oldPath), oldText, newText,
      rows, hunks: groupHunks(rows), span: null, added, removed,
    };
  }));
}

async function addTokens(s) {
  if (s.binary) return;
  s.newTokens = s.newText ? await highlightLines(s.newText, s.lang) : [];
  s.oldTokens = s.oldText ? await highlightLines(s.oldText, s.lang) : [];
}

function sectionPaths(s) {
  if (s.mode === 'diff' && s.oldPath && s.newPath && s.oldPath !== s.newPath) return [s.oldPath, s.newPath];
  return [s.path];
}

/** Canonical, pinned tokens used in URLs. */
function linkTokens(walk, repo, result, s) {
  const t = [];
  if (walk.multiRepo || !repo.isDefault) t.push('-C', repo.name);
  if (s.mode === 'file') {
    const side = s.sides[0];
    t.push('show', side.type === 'commit' ? `${side.sha.slice(0, 12)}:${s.path}` : side.type === 'index' ? `:${s.path}` : s.path);
    return t;
  }
  const [o, n] = s.sides;
  if (result.kind === 'commit') {
    t.push('show', n.sha.slice(0, 12), '--', ...sectionPaths(s));
    return t;
  }
  t.push('diff');
  if (o.type === 'commit' && n.type === 'commit') t.push(`${o.sha.slice(0, 12)}..${n.sha.slice(0, 12)}`);
  else if (o.type === 'commit' && n.type === 'index') t.push('--cached', o.sha.slice(0, 12));
  else if (o.type === 'commit') t.push(o.sha.slice(0, 12));
  t.push('--', ...sectionPaths(s));
  return t;
}

/** The git command a human would run, with refs as written. */
function displayCommand(repo, result, s) {
  const { ref } = result;
  const t = ['git'];
  const dirArg = repoDirArg(repo);
  if (dirArg) t.push('-C', dirArg);
  if (s.mode === 'file') {
    const side = s.sides[0];
    if (side.type === 'worktree') return `cat ${repo.isDefault ? s.path : path.join(repo.configured, s.path)}`;
    t.push('show', side.type === 'commit' ? `${side.rev}:${s.path}` : `:${s.path}`);
  } else if (result.kind === 'commit') {
    t.push('show', ref.target, '--', ...sectionPaths(s));
  } else {
    t.push('diff');
    if (ref.cached) t.push('--cached');
    t.push(...ref.revs, '--', ...sectionPaths(s));
  }
  return t.join(' ');
}

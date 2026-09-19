// `--stat` summary blocks: per-file change counts for any diff, optionally grouped and annotated.
import YAML from 'yaml';
import { changedFiles, commitsBetween, numstat, resolveCommit } from './git.js';
import { RefError } from './refs.js';
import { commitSides, diffSides } from './resolve.js';
import { repoDirArg, resolveRepo } from './walk.js';

export const UNGROUPED = 'Ungrouped';

/** Glob → RegExp. `**` spans directories, `*` and `?` stay within one segment, a trailing `/` means "everything under". */
export function globToRegExp(pattern) {
  let p = pattern.trim().replace(/^\.\//, '');
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Parse a --stat block body into groups: [{ name, note, patterns: [{ pattern, re, note }] }].
 * Body is YAML: a list of { group, note?, files } where files is a list of globs or a map glob → note.
 */
export function parseGroups(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  let data;
  try {
    data = YAML.parse(text);
  } catch (e) {
    throw new RefError(`--stat groups are not valid YAML: ${e.message.split('\n')[0]}`);
  }
  if (!Array.isArray(data)) {
    throw new RefError('--stat body must be a YAML list of groups, e.g.\n- group: Backend\n  files: [src/**]');
  }
  return data.map((g, i) => {
    if (!g || typeof g !== 'object' || Array.isArray(g)) throw new RefError(`group ${i + 1} must be a mapping with "group" and "files"`);
    const unknown = Object.keys(g).filter((k) => !['group', 'note', 'files'].includes(k));
    if (unknown.length) throw new RefError(`group ${i + 1}: unknown key "${unknown[0]}" (use group, note, files)`);
    if (g.group === undefined || g.group === null || String(g.group).trim() === '') throw new RefError(`group ${i + 1} needs a name ("group: …")`);
    const name = String(g.group).trim();
    if (name === UNGROUPED) throw new RefError(`"${UNGROUPED}" is reserved for files no group matches`);
    let entries;
    if (typeof g.files === 'string') entries = [[g.files, null]];
    else if (Array.isArray(g.files)) entries = g.files.map((f) => [String(f), null]);
    else if (g.files && typeof g.files === 'object') entries = Object.entries(g.files).map(([f, note]) => [f, note == null ? null : String(note)]);
    else throw new RefError(`group "${name}" needs "files": a glob, a list of globs, or a map of glob → note`);
    if (!entries.length) throw new RefError(`group "${name}" has no files`);
    return {
      name,
      note: g.note == null ? null : String(g.note),
      patterns: entries.map(([pattern, note]) => ({ pattern, re: globToRegExp(pattern), note })),
    };
  });
}

export async function resolveStat(walk, ref, body) {
  const repo = await resolveRepo(walk, ref.repo);
  const { root } = repo;
  let sides;
  let commit = null;
  if (ref.command === 'show') {
    await resolveCommit(root, ref.target);
    sides = await commitSides(root, ref.target);
    commit = sides[1].info;
  } else {
    sides = await diffSides(root, ref);
  }
  const [oldSide, newSide] = sides;
  const paths = ref.paths.map((p) => p.replace(/^\.\//, ''));
  const [changed, counts] = await Promise.all([
    changedFiles(root, oldSide, newSide, paths),
    numstat(root, oldSide, newSide, paths),
  ]);

  const files = changed.map((f) => {
    const path = f.newPath || f.oldPath;
    const c = counts.get(path) || { added: 0, removed: 0, binary: false };
    return { status: f.status, path, oldPath: f.oldPath, added: c.added, removed: c.removed, binary: c.binary };
  });

  const commits = oldSide.type === 'commit' && newSide.type === 'commit' && ref.command === 'diff'
    ? (await commitsBetween(root, oldSide.sha, newSide.sha)).length
    : null;

  const defs = parseGroups(body);
  const warnings = [];
  const used = new Set();
  const groups = defs.map((d) => ({ name: d.name, note: d.note, files: [] }));
  const ungrouped = { name: UNGROUPED, note: null, files: [], implicit: true };

  for (const file of files) {
    let placed = false;
    for (let gi = 0; gi < defs.length && !placed; gi++) {
      for (const p of defs[gi].patterns) {
        // A rename matches by either its new or its old path.
        if (p.re.test(file.path) || (file.oldPath && p.re.test(file.oldPath))) {
          groups[gi].files.push({ ...file, note: p.note });
          used.add(p);
          placed = true;
          break;
        }
      }
    }
    if (!placed) ungrouped.files.push({ ...file, note: null });
  }
  for (const d of defs) {
    for (const p of d.patterns) {
      if (!used.has(p) && !files.some((f) => p.re.test(f.path) || (f.oldPath && p.re.test(f.oldPath)))) {
        warnings.push(`group "${d.name}": "${p.pattern}" matches no changed files`);
      }
    }
  }
  if (!defs.length) ungrouped.implicit = false;
  const all = [...groups.filter((g) => g.files.length), ...(ungrouped.files.length ? [ungrouped] : [])];
  for (const g of all) Object.assign(g, sum(g.files));

  return {
    ref, repo, sides, commit, commits, files, groups: all, grouped: defs.length > 0,
    totals: sum(files), warnings, displayCmd: displayCommand(repo, ref),
  };
}

function sum(files) {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed, count: t.count + 1 }), { added: 0, removed: 0, count: 0 });
}

function displayCommand(repo, ref) {
  const t = ['git'];
  const dirArg = repoDirArg(repo);
  if (dirArg) t.push('-C', dirArg);
  t.push(ref.command, '--stat');
  if (ref.cached) t.push('--cached');
  t.push(...ref.revs);
  if (ref.target) t.push(ref.target);
  if (ref.paths.length) t.push('--', ...ref.paths);
  return t.join(' ');
}

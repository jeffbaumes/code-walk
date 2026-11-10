// Loading a walk file: frontmatter, repo configuration.
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import YAML from 'yaml';
import { repoRoot, GitError } from './git.js';
import { cacheDirFor, ensureRemote, isRemoteUrl, remoteName } from './remote.js';
import { isRefInfo } from './refs.js';
import { withFileLock } from './comments.js';

export function splitFrontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, bodyLineOffset: 0 };
  let data = {};
  try {
    data = YAML.parse(m[1]) || {};
  } catch (e) {
    throw new Error(`invalid frontmatter: ${e.message}`);
  }
  return { data, body: src.slice(m[0].length), bodyLineOffset: m[0].split('\n').length - 1 };
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** A repo entry for a `repo:` / `repos:` value, which is a path (relative to the walk) or a git URL. */
function repoEntry(name, value, dir) {
  const configured = String(value);
  if (isRemoteUrl(configured)) return { name, configured, path: cacheDirFor(configured), remote: configured };
  return { name, configured, path: path.resolve(dir, expandHome(configured)) };
}

/**
 * A walk context knows how to find repos.
 *   { walkPath, dir, title, data, body, bodyLineOffset, repos: [{name, path}], defaultRepo, multiRepo }
 */
export async function loadWalk(walkPath, { fallbackDir = process.cwd(), assignIds = false } = {}) {
  let src = await readFile(walkPath, 'utf8');
  // Fully marked walks need no writes, including the comments lock directory.
  if (assignIds && assignBlockIds(src) !== src) {
    try {
      src = await withFileLock(path.resolve(walkPath), async () => {
        const file = await realpath(walkPath);
        const original = await readFile(file, 'utf8');
        const updated = assignBlockIds(original);
        if (updated === original) return original;
        const tmp = `${file}.${randomUUID()}.tmp`;
        try {
          const mode = (await stat(file)).mode;
          await writeFile(tmp, updated, { mode, flag: 'wx' });
          await chmod(tmp, mode);
          if (await readFile(file, 'utf8') !== original) throw new Error('walk changed while assigning block IDs; reload and try again');
          await rename(tmp, file);
        } finally {
          await rm(tmp, { force: true });
        }
        return updated;
      });
    } catch (e) {
      if (!['EACCES', 'EROFS', 'EPERM'].includes(e.code)) throw e;
      // Render the saved source, not unsaved random IDs that would change on reload.
      src = await readFile(walkPath, 'utf8');
    }
  }
  return walkFromSource(src, walkPath, { fallbackDir });
}

const blockMd = new MarkdownIt({ html: false });

function assignBlockIds(source) {
  const { body, bodyLineOffset } = splitFrontmatter(source);
  const lines = source.split(/(?<=\n)/);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  // Work backwards so inserted lines do not change the remaining token positions.
  for (const t of blockMd.parse(body, {}).reverse()) {
    if (t.type !== 'fence' || !isRefInfo(t.info) || /^\s*# code-walk-id:/m.test(t.content)) continue;
    const index = bodyLineOffset + t.map[0];
    const opening = lines[index];
    // Keep blockquote/indent prefixes; replace any list marker with indentation.
    const prefix = opening.slice(0, opening.indexOf(t.markup)).replace(/(?:[-+*]|\d+[.)])(?=\s)/g, (m) => ' '.repeat(m.length));
    lines.splice(index + 1, 0, `${opening.endsWith('\n') ? '' : eol}${prefix}# code-walk-id: ${randomUUID()}${eol}`);
  }
  return lines.join('');
}

export async function walkFromSource(src, walkPath, { fallbackDir = process.cwd() } = {}) {
  const { data, body, bodyLineOffset } = splitFrontmatter(src);
  const dir = walkPath ? path.dirname(path.resolve(walkPath)) : fallbackDir;
  const repos = [];
  const single = data.repo ? String(data.repo) : null;
  const declared = data.repos ?? (single ? { [isRemoteUrl(single) ? remoteName(single) : path.basename(path.resolve(dir, expandHome(single)))]: single } : null);
  if (declared && typeof declared === 'object') {
    for (const [name, p] of Object.entries(declared)) repos.push(repoEntry(name, p, dir));
  }
  if (!repos.length) {
    const root = (await repoRoot(dir)) || (await repoRoot(fallbackDir));
    if (root) repos.push({ name: path.basename(root), configured: root, path: root });
  }
  return {
    walkPath: walkPath ? path.resolve(walkPath) : null,
    dir,
    title: data.title ? String(data.title) : null,
    data,
    body,
    bodyLineOffset,
    repos,
    multiRepo: repos.length > 1,
    rootCache: new Map(),
  };
}

/** Resolve a `-C` value (name or path) to {name, root}. */
export async function resolveRepo(walk, name) {
  let entry;
  if (name == null) {
    entry = walk.repos[0];
    if (!entry) throw new GitError('no git repository found (add `repo:` or `repos:` to the frontmatter)');
  } else {
    entry = walk.repos.find((r) => r.name === name);
    if (!entry && isRemoteUrl(name)) {
      entry = { ...repoEntry(name, name, walk.dir), adhoc: true };
    } else if (!entry) {
      const p = path.resolve(walk.dir, expandHome(name));
      if (!existsSync(p) || !statSync(p).isDirectory()) {
        const known = walk.repos.map((r) => r.name).join(', ');
        throw new GitError(`unknown repo "${name}"${known ? ` (known: ${known})` : ''}`);
      }
      entry = { name, configured: name, path: p, adhoc: true };
    }
  }
  if (!walk.rootCache.has(entry.path)) {
    walk.rootCache.set(entry.path, (async () => {
      if (entry.remote) await ensureRemote(entry.remote, entry.path);
      return repoRoot(entry.path);
    })());
  }
  const root = await walk.rootCache.get(entry.path);
  if (!root) throw new GitError(`not a git repository: ${entry.remote || entry.path}`);
  return { name: entry.name, root, isDefault: entry === walk.repos[0], configured: entry.configured, remote: entry.remote || null };
}

/** The `-C <dir>` a runnable git command needs for this repo, or null when the cwd is right. */
export function repoDirArg(repo) {
  // A remote repo lives in the clone cache, so a runnable command has to say where.
  if (repo.remote) return repo.root.startsWith(os.homedir() + path.sep) ? `~${repo.root.slice(os.homedir().length)}` : repo.root;
  return repo.isDefault ? null : repo.configured;
}

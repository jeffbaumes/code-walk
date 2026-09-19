// Thin, safe wrapper around the git CLI. Always execFile with argument arrays; never a shell.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class GitError extends Error {}

function git(cwd, args, { buffer = false, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          if (allowFail) return resolve(null);
          const msg = String(stderr || err.message).trim().split('\n')[0];
          return reject(new GitError(msg || `git ${args[0]} failed`));
        }
        resolve(stdout);
      },
    );
  });
}

function assertSafeRev(rev) {
  if (!rev || rev.startsWith('-')) throw new GitError(`invalid revision "${rev}"`);
}

const cache = new Map();
function memo(key, fn) {
  if (!cache.has(key)) {
    const p = fn();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

export async function repoRoot(dir) {
  const out = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (out) return out.trim();
  // A bare repo (such as the clone of a remote repo) has no work tree; its git dir is the root.
  const bare = await git(dir, ['rev-parse', '--is-bare-repository'], { allowFail: true });
  if (bare && bare.trim() === 'true') return (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  return null;
}

function isBare(root) {
  return memo(`bare:${root}`, async () => (await git(root, ['rev-parse', '--is-bare-repository'])).trim() === 'true');
}

/** Resolve a revision to a full commit sha. Not memoized: branches move. */
export async function resolveCommit(root, rev) {
  assertSafeRev(rev);
  const out = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { allowFail: true });
  if (!out) throw new GitError(`unknown revision "${rev}"`);
  return out.trim();
}

export async function tryResolveCommit(root, rev) {
  if (!rev || rev.startsWith('-')) return null;
  const out = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { allowFail: true });
  return out ? out.trim() : null;
}

export async function firstParent(root, sha) {
  const out = await git(root, ['rev-parse', '--verify', '--quiet', `${sha}^1`], { allowFail: true });
  return out ? out.trim() : null;
}

export async function mergeBase(root, a, b) {
  const out = await git(root, ['merge-base', a, b], { allowFail: true });
  if (!out) throw new GitError(`no merge base between ${a} and ${b}`);
  return out.trim();
}

export function commitInfo(root, sha) {
  return memo(`info:${root}:${sha}`, async () => {
    if (sha === EMPTY_TREE) return { sha, subject: '(empty tree)', body: '', author: '', email: '', date: '' };
    const out = await git(root, ['log', '-1', '--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00%b', sha]);
    const [full, author, email, date, subject, body] = out.split('\x00');
    return { sha: full, author, email, date, subject, body: (body || '').trim() };
  });
}

export async function commitsBetween(root, from, to) {
  const out = await git(root, ['log', '--reverse', '--format=%H%x00%s', `${from}..${to}`]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, subject] = l.split('\x00');
    return { sha, subject };
  });
}

/**
 * Read a file from a side. side: {type:'commit', sha} | {type:'index'} | {type:'worktree'}.
 * Returns a Buffer, or null if the path does not exist on that side.
 */
export async function readSide(root, side, file) {
  if (side.type !== 'commit' && (await isBare(root))) {
    throw new GitError(`${side.type === 'index' ? 'the staged index' : 'the working tree'} isn't available in a remote repo; use a branch, tag or commit`);
  }
  return readSideUnchecked(root, side, file);
}

function readSideUnchecked(root, side, file) {
  if (side.type === 'commit') {
    return memo(`blob:${root}:${side.sha}:${file}`, () =>
      git(root, ['cat-file', 'blob', `${side.sha}:${file}`], { buffer: true, allowFail: true }),
    );
  }
  if (side.type === 'index') {
    return git(root, ['cat-file', 'blob', `:${file}`], { buffer: true, allowFail: true });
  }
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new GitError(`path escapes the repo: ${file}`);
  return readFile(abs).catch(() => null);
}

function diffArgs(oldSide, newSide) {
  if (oldSide.type === 'commit' && newSide.type === 'commit') return [oldSide.sha, newSide.sha];
  if (oldSide.type === 'commit' && newSide.type === 'index') return ['--cached', oldSide.sha];
  if (oldSide.type === 'commit' && newSide.type === 'worktree') return [oldSide.sha];
  if (oldSide.type === 'index' && newSide.type === 'worktree') return [];
  throw new GitError(`cannot diff ${oldSide.type} against ${newSide.type}`);
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M'];

/** Changed files between two sides: [{status, oldPath, newPath}] */
export async function changedFiles(root, oldSide, newSide, paths = []) {
  const out = await git(root, ['diff', ...DIFF_FLAGS, '--name-status', '-z', ...diffArgs(oldSide, newSide), '--', ...paths]);
  const parts = out.split('\x00');
  const files = [];
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i++];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      files.push({ status: code, oldPath: parts[i++], newPath: parts[i++] });
    } else {
      const p = parts[i++];
      files.push({ status: code, oldPath: code === 'A' ? null : p, newPath: code === 'D' ? null : p });
    }
  }
  return files;
}

/** Exact change regions for one file (from -U0): [{oldStart, oldCount, newStart, newCount}] */
export async function changeRegions(root, oldSide, newSide, file) {
  const paths = [...new Set([file.oldPath, file.newPath].filter(Boolean))];
  const out = await git(root, ['diff', ...DIFF_FLAGS, '-U0', ...diffArgs(oldSide, newSide), '--', ...paths]);
  const regions = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = re.exec(out))) {
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    regions.push({
      oldStart: oldCount === 0 ? Number(m[1]) + 1 : Number(m[1]),
      oldCount,
      newStart: newCount === 0 ? Number(m[3]) + 1 : Number(m[3]),
      newCount,
    });
  }
  return { regions, binary: /^Binary files /m.test(out) };
}

export async function defaultBase(root) {
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (head) return head.trim();
  for (const b of ['main', 'master', 'origin/main', 'origin/master']) {
    if (await tryResolveCommit(root, b)) return b;
  }
  return null;
}

export async function userName(root) {
  const out = await git(root, ['config', 'user.name'], { allowFail: true });
  return out ? out.trim() : null;
}

/** Per-file line counts between two sides: Map newPath|oldPath -> {added, removed, binary}. */
export async function numstat(root, oldSide, newSide, paths = []) {
  const out = await git(root, ['diff', ...DIFF_FLAGS, '--numstat', '-z', ...diffArgs(oldSide, newSide), '--', ...paths]);
  const stats = new Map();
  const parts = out.split('\x00');
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    let file = m[3];
    if (file === '') {
      // Rename or copy: the old and new paths follow as separate fields.
      i += 2;
      file = parts[i];
    }
    stats.set(file, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  return stats;
}

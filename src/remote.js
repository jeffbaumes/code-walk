// Repos given as URLs: kept as bare clones in a cache dir and refreshed once per process.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitError } from './git.js';

// scheme://…, or scp-style user@host:path. `ext::` and other exotic transports are not URLs here.
const URL_RE = /^(?:(?:https?|ssh|git|file):\/\/\S+|[\w.-]+@[\w.-]+:[^\s:]\S*)$/i;

export function isRemoteUrl(s) {
  return URL_RE.test(String(s));
}

/** Short display name: the last path segment without `.git`. */
export function remoteName(url) {
  const last = String(url).replace(/[/\\]+$/, '').split(/[/:\\]/).pop() || 'repo';
  return last.replace(/\.git$/i, '') || 'repo';
}

export function cacheHome() {
  return path.join(process.env.CODE_WALK_HOME || path.join(os.homedir(), '.code-walk'), 'repos');
}

export function cacheDirFor(url) {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
  return path.join(cacheHome(), `${remoteName(url).replace(/[^\w.-]/g, '_')}-${hash}`);
}

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: 5 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
      },
    }, (err, _out, stderr) => {
      if (err) return reject(new GitError(String(stderr || err.message).trim().split('\n').filter(Boolean).pop() || 'git failed'));
      resolve();
    });
  });
}

const FETCH = ['fetch', '--quiet', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'];
const ensured = new Map();

/**
 * Make sure `dir` holds an up-to-date bare clone of `url`. Branches and tags keep their names
 * (`main`, `feature/x`, `v1.2`). Fetches at most once per process; if a refresh fails, the
 * existing clone is used as-is.
 */
export function ensureRemote(url, dir = cacheDirFor(url)) {
  if (!ensured.has(url)) {
    const p = (async () => {
      if (existsSync(path.join(dir, 'HEAD'))) {
        await run(FETCH, dir).catch((e) => console.error(`code-walk: could not update ${url} (${e.message}); using the cached clone`));
        return dir;
      }
      mkdirSync(path.dirname(dir), { recursive: true });
      console.error(`code-walk: cloning ${url} …`);
      try {
        await run(['clone', '--bare', '--quiet', '--', url, dir]);
      } catch (e) {
        throw new GitError(`could not clone ${url}: ${e.message}`);
      }
      return dir;
    })();
    ensured.set(url, p);
    p.catch(() => ensured.delete(url));
  }
  return ensured.get(url);
}

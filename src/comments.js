// Review comments: stored in a sidecar JSON file next to each walk (<walk>.comments.json).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function sidecarPath(walkPath) {
  return walkPath.replace(/\.md$/i, '') + '.comments.json';
}

export async function loadComments(walkPath) {
  const file = sidecarPath(walkPath);
  if (!existsSync(file)) return { version: 1, comments: [] };
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const comments = Array.isArray(data.comments) ? data.comments : [];
    // Older files have replies without ids: derive a stable one (persisted on the next write).
    for (const c of comments) {
      c.replies = Array.isArray(c.replies) ? c.replies : [];
      for (const r of c.replies) {
        r.id ??= createHash('sha1').update(`${c.id}\0${r.created}\0${r.author}\0${r.body}`).digest('hex').slice(0, 6);
      }
    }
    return { version: 1, comments };
  } catch (e) {
    throw new Error(`could not read ${file}: ${e.message}`);
  }
}

async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

export async function saveComments(walkPath, data) {
  await atomicWrite(sidecarPath(walkPath), JSON.stringify(data, null, 2) + '\n');
}

// Serialize read-modify-write per walk: a promise chain within this process, plus a lock
// directory so the server and CLI processes never interleave a read and a write.
const locks = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withFileLock(walkPath, fn) {
  const lock = `${sidecarPath(walkPath)}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock older than a few seconds was left by a crashed process.
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 5000) await rm(lock, { recursive: true, force: true });
      else if (attempt > 200) throw new Error(`comments file is locked: ${lock}`);
      else await sleep(10);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function update(walkPath, fn) {
  const prev = locks.get(walkPath) || Promise.resolve();
  const next = prev.then(() => withFileLock(walkPath, async () => {
    const data = await loadComments(walkPath);
    const result = await fn(data);
    await saveComments(walkPath, data);
    return result;
  }));
  locks.set(walkPath, next.catch(() => {}));
  return next;
}

const newId = () => randomBytes(3).toString('hex');
const now = () => new Date().toISOString();

function cleanAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const lines = Array.isArray(a.lines)
    ? a.lines.slice(0, 200).map((l) => ({
      o: Number.isInteger(l.o) ? l.o : null,
      n: Number.isInteger(l.n) ? l.n : null,
      t: [' ', '+', '-'].includes(l.t) ? l.t : ' ',
      text: str(l.text, 1000) ?? '',
    }))
    : [];
  return {
    link: str(a.link), range: str(a.range, 40), path: str(a.path, 1000), mode: a.mode === 'diff' ? 'diff' : 'file',
    repo: str(a.repo, 1000), repoName: str(a.repoName, 200), command: str(a.command), section: str(a.section, 300), lines,
  };
}

function findIn(data, id) {
  const matches = data.comments.filter((c) => c.id === id || c.id.startsWith(id));
  if (!matches.length) throw new Error(`no comment with id "${id}"`);
  if (matches.length > 1) throw new Error(`comment id "${id}" is ambiguous`);
  return matches[0];
}

export function addComment(walkPath, { anchor, body, author }) {
  if (!body || !String(body).trim()) throw new Error('comment body is empty');
  return update(walkPath, (data) => {
    const c = { id: newId(), author: author || 'You', created: now(), status: 'open', anchor: cleanAnchor(anchor), body: String(body).trim(), replies: [] };
    while (data.comments.some((x) => x.id === c.id)) c.id = newId();
    data.comments.push(c);
    return c;
  });
}

export function addReply(walkPath, id, { body, author, resolve = false }) {
  if (!body || !String(body).trim()) throw new Error('reply body is empty');
  return update(walkPath, (data) => {
    const c = findIn(data, id);
    let rid = newId();
    while (c.replies.some((r) => r.id === rid)) rid = newId();
    c.replies.push({ id: rid, author: author || 'You', created: now(), body: String(body).trim() });
    if (resolve) { c.status = 'resolved'; c.resolved = now(); }
    return c;
  });
}

export function setStatus(walkPath, id, status) {
  if (status !== 'open' && status !== 'resolved') throw new Error(`bad status "${status}"`);
  return update(walkPath, (data) => {
    const c = findIn(data, id);
    c.status = status;
    if (status === 'resolved') c.resolved = now(); else delete c.resolved;
    return c;
  });
}

function findReply(c, replyId) {
  const r = c.replies.find((x) => x.id === replyId);
  if (!r) throw new Error(`no reply "${replyId}" on comment ${c.id}`);
  return r;
}

/** Thrown when an edit was based on text that has since changed. `current` is the latest text. */
export class EditConflictError extends Error {
  constructor(message, current) {
    super(message);
    this.current = current;
  }
}

/**
 * Edit a thread's first message, or one of its replies when replyId is given.
 * `base` is the text the editor started from; if the message has changed since, nothing is
 * written and EditConflictError is thrown, so concurrent edits never silently overwrite each other.
 */
export async function editComment(walkPath, id, body, replyId = null, { base } = {}) {
  if (!body || !String(body).trim()) throw new Error('comment body is empty');
  if (typeof base !== 'string') throw new Error('an edit needs the text it was based on');
  return update(walkPath, (data) => {
    const c = findIn(data, id);
    const target = replyId ? findReply(c, replyId) : c;
    if (target.body !== base.trim()) {
      throw new EditConflictError('this message changed since you started editing it', target.body);
    }
    target.body = String(body).trim();
    target.edited = now();
    return c;
  });
}

/**
 * Replace `oldText` with `newText` inside a message, like a string-replace file edit.
 * `oldText` must occur exactly once in the current text, which proves the caller has seen it.
 */
export async function replaceInComment(walkPath, id, oldText, newText, replyId = null) {
  if (!oldText) throw new Error('--old text is required');
  return update(walkPath, (data) => {
    const c = findIn(data, id);
    const target = replyId ? findReply(c, replyId) : c;
    const count = target.body.split(oldText).length - 1;
    if (count === 0) throw new EditConflictError('--old text was not found in the current message', target.body);
    if (count > 1) throw new EditConflictError(`--old text matches ${count} places; include more surrounding text`, target.body);
    const body = target.body.replace(oldText, () => newText).trim();
    if (!body) throw new Error('the edit would leave the message empty');
    target.body = body;
    target.edited = now();
    return c;
  });
}

/** Delete a whole thread, or just one reply when replyId is given. Returns the thread. */
export function deleteComment(walkPath, id, replyId = null) {
  return update(walkPath, (data) => {
    const c = findIn(data, id);
    if (replyId) {
      const r = findReply(c, replyId);
      c.replies = c.replies.filter((x) => x !== r);
    } else {
      data.comments = data.comments.filter((x) => x !== c);
    }
    return c;
  });
}

// ---- registry of served walks, so `code-walk comments` can find them from any repo ----

function registryFile() {
  const home = process.env.CODE_WALK_HOME || path.join(os.homedir(), '.code-walk');
  return path.join(home, 'recent.json');
}

export async function readRegistry() {
  try {
    const data = JSON.parse(await readFile(registryFile(), 'utf8'));
    return Array.isArray(data.walks) ? data.walks.filter((w) => w && typeof w.walkPath === 'string') : [];
  } catch {
    return [];
  }
}

let registryQueue = Promise.resolve();
export function recordWalk(walkPath, repoRoots) {
  registryQueue = registryQueue.then(async () => {
    const file = registryFile();
    const walks = (await readRegistry()).filter((w) => w.walkPath !== walkPath && existsSync(w.walkPath));
    walks.unshift({ walkPath, repos: repoRoots, lastSeen: now() });
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, JSON.stringify({ walks: walks.slice(0, 100) }, null, 2) + '\n');
  }).catch(() => {});
  return registryQueue;
}

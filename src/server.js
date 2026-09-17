// Local HTTP server: renders walks, serves assets, pushes live reloads.
import http from 'node:http';
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadWalk } from './walk.js';
import { prepareWalk, renderWalkHtml, pageHtml, esc, tildify, renderCommentBody } from './render.js';
import { EditConflictError, addComment, addReply, deleteComment, editComment, loadComments, recordWalk, setStatus } from './comments.js';
import { repoRoot, userName } from './git.js';
import { resolveUrlText } from './commands/resolve.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WEB = path.join(here, '..', 'web');

const ASSETS = {
  'app.css': [path.join(WEB, 'app.css'), 'text/css; charset=utf-8'],
  'app.js': [path.join(WEB, 'app.js'), 'text/javascript; charset=utf-8'],
  'mermaid.min.js': [path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js'), 'text/javascript; charset=utf-8'],
};

const SKIP_DIRS = new Set(['node_modules', '.git']);

async function listWalks(root, dir = root, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) await listWalks(root, path.join(dir, ent.name), out);
    } else if (ent.name.endsWith('.md')) {
      out.push(path.relative(root, path.join(dir, ent.name)).slice(0, -3).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

export function startServer({ target, port = 4747, host = '127.0.0.1', onListen }) {
  const abs = path.resolve(target);
  if (!existsSync(abs)) throw new Error(`not found: ${target}`);
  const isDir = statSync(abs).isDirectory();
  const root = isDir ? abs : path.dirname(abs);
  const single = isDir ? null : path.basename(abs, '.md');
  const clients = new Set();

  const walkFile = (name) => {
    const file = path.resolve(root, `${name}.md`);
    if (!file.startsWith(root + path.sep) || !existsSync(file)) return null;
    return file;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);

      if (p === '/') {
        if (single) return redirect(res, `/w/${encodeURI(single)}`);
        const walks = await listWalks(root);
        return send(res, 200, 'text/html; charset=utf-8', indexPage(root, walks));
      }
      if (p.startsWith('/assets/')) {
        const asset = ASSETS[p.slice(8)];
        if (!asset) return send(res, 404, 'text/plain', 'not found');
        res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-cache' });
        return createReadStream(asset[0]).pipe(res);
      }
      if (p === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('retry: 1000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/resolve') {
        const name = url.searchParams.get('walk');
        const frag = url.searchParams.get('frag') || '';
        const file = name ? walkFile(name) : null;
        if (name && !file) return send(res, 404, 'text/plain; charset=utf-8', `walk not found: ${name}`);
        const text = await resolveUrlText(frag, { walkPath: file, cwd: root });
        return send(res, 200, 'text/plain; charset=utf-8', text);
      }
      if (p.startsWith('/api/comments')) {
        const name = url.searchParams.get('walk') || single;
        const file = name ? walkFile(name) : null;
        if (!file) return sendJson(res, 404, { error: `walk not found: ${name}` });
        if (req.method === 'GET') {
          const { comments } = await loadComments(file);
          return sendJson(res, 200, { me: await authorFor(file), comments: comments.map(withHtml) });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });
        const body = await readJson(req);
        const id = url.searchParams.get('id');
        const action = p.slice('/api/comments'.length) || '/';
        try {
          let c;
          if (action === '/') c = await addComment(file, { anchor: body.anchor, body: body.body, author: await authorFor(file) });
          else if (action === '/reply') c = await addReply(file, id, { body: body.body, author: await authorFor(file) });
          else if (action === '/status') c = await setStatus(file, id, body.status);
          else if (action === '/edit') c = await editComment(file, id, body.body, body.reply || null, { base: body.base });
          else if (action === '/delete') c = await deleteComment(file, id, body.reply || null);
          else return sendJson(res, 404, { error: 'unknown action' });
          notify(name, 'comments');
          return sendJson(res, 200, { comment: withHtml(c) });
        } catch (e) {
          if (e instanceof EditConflictError) return sendJson(res, 409, { error: e.message, current: e.current });
          return sendJson(res, 400, { error: e.message });
        }
      }
      if (p.startsWith('/w/')) {
        const name = p.slice(3);
        const file = walkFile(name);
        if (!file) return send(res, 404, 'text/html; charset=utf-8', `<p>Walk not found: ${esc(name)}</p>`);
        const walk = await loadWalk(file, { fallbackDir: root });
        recordWalk(file, walk.repos.map((r) => r.path));
        const prepared = await prepareWalk(walk);
        const content = renderWalkHtml(prepared, walk);
        const html = pageHtml({
          title: prepared.title, toc: prepared.toc, content, walk, walkName: name,
          hasMermaid: prepared.tokens.some((t) => t.type === 'fence' && t.info.trim().split(/\s+/)[0] === 'mermaid'),
        });
        return send(res, 200, 'text/html; charset=utf-8', html);
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      send(res, 500, 'text/html; charset=utf-8', `<pre style="white-space:pre-wrap;padding:2rem">${esc(e.stack || e.message)}</pre>`);
    }
  });

  // Live updates: a walk edit reloads its pages; a comments edit (browser or CLI) refreshes threads.
  let timer;
  const pending = new Map();
  const flush = () => {
    for (const [key, kind] of pending) {
      const walk = key.slice(0, key.lastIndexOf('\0'));
      for (const c of clients) c.write(`data: ${JSON.stringify({ walk, kind })}\n\n`);
    }
    pending.clear();
  };
  const notify = (name, kind) => {
    pending.set(`${name}\0${kind}`, kind);
    clearTimeout(timer);
    timer = setTimeout(flush, 80);
  };
  const authors = new Map();
  const authorFor = async (file) => {
    if (!authors.has(file)) {
      const walk = await loadWalk(file, { fallbackDir: root });
      const r = walk.repos[0] && (await repoRoot(walk.repos[0].path));
      authors.set(file, (r && (await userName(r))) || 'You');
    }
    return authors.get(file);
  };
  try {
    watch(root, { recursive: true }, (_event, filename) => {
      const f = String(filename || '');
      const name = f.split(path.sep).join('/');
      if (f.endsWith('.comments.json')) notify(name.slice(0, -'.comments.json'.length), 'comments');
      else if (f.endsWith('.md')) notify(name.slice(0, -3), 'walk');
    });
  } catch {
    // Recursive watch unsupported; live reload disabled.
  }
  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);
  server.on('close', () => clearInterval(ping));

  let attempts = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempts++ < 20) {
      port += 1;
      server.listen(port, host);
    } else {
      throw e;
    }
  });
  server.on('listening', () => onListen?.({ url: `http://localhost:${server.address().port}${single ? `/w/${encodeURI(single)}` : '/'}`, port: server.address().port }));
  server.listen(port, host);
  return server;
}

function withHtml(c) {
  return { ...c, bodyHtml: renderCommentBody(c.body), replies: (c.replies || []).map((r) => ({ ...r, bodyHtml: renderCommentBody(r.body) })) };
}

function sendJson(res, status, data) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

/** Refuse writes from other websites: require JSON and a matching Origin when one is sent. */
function sameOrigin(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('request too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function indexPage(root, walks) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Code Walks</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><div class="cw-layout"><main class="cw-main"><header class="cw-header"><h1>Code walks</h1><div class="cw-walkmeta"><code>${esc(tildify(root))}</code></div></header>
<article class="cw-article">${walks.length ? `<ul class="cw-index">${walks.map((w) => `<li><a href="/w/${encodeURI(w)}">${esc(w)}</a></li>`).join('')}</ul>` : '<p>No <code>.md</code> files here yet.</p>'}</article></main></div>
<script>window.CODE_WALK = {};</script><script src="/assets/app.js"></script></body></html>`;
}

// `code-walk build <walk.md|dir> [-o <out>]`: render walks to self-contained static HTML pages.
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadWalk } from '../walk.js';
import { loadComments } from '../comments.js';
import { prepareWalk, renderWalkHtml, pageHtml, esc, commentWithHtml } from '../render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WEB = path.join(here, '..', '..', 'web');
const MERMAID = path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js');

const SKIP_DIRS = new Set(['node_modules', '.git']);

async function listWalks(dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) await listWalks(path.join(dir, ent.name), out);
    } else if (ent.name.endsWith('.md')) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out.sort();
}

/** One walk as a standalone page: CSS and JS inline, existing comments shown read-only. */
export async function buildPage(file, { name = path.basename(file, '.md'), comments = true } = {}) {
  const walk = await loadWalk(file);
  const prepared = await prepareWalk(walk);
  const errors = prepared.refs.filter((r) => r.error);
  const content = renderWalkHtml(prepared, walk, { isStatic: true });
  const hasMermaid = prepared.tokens.some((t) => t.type === 'fence' && t.info.trim().split(/\s+/)[0] === 'mermaid');
  const inline = {
    css: await readFile(path.join(WEB, 'app.css'), 'utf8'),
    js: await readFile(path.join(WEB, 'app.js'), 'utf8'),
    mermaid: hasMermaid ? await readFile(MERMAID, 'utf8') : null,
  };
  // Anchors record the local repo path; a published page has no use for it.
  const threads = comments ? (await loadComments(file)).comments.map((c) => commentWithHtml({ ...c, anchor: c.anchor && { ...c.anchor, repo: undefined } })) : [];
  const html = pageHtml({ title: prepared.title, toc: prepared.toc, content, walk, walkName: name, hasMermaid, inline, comments: threads });
  return { html, errors, comments: threads.length };
}

function indexPage(pages) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Code Walks</title><style>${pages.css}</style></head>
<body><div class="cw-layout"><main class="cw-main"><header class="cw-header"><h1>Code walks</h1></header>
<article class="cw-article"><ul class="cw-index">${pages.list.map((p) => `<li><a href="${encodeURI(p.href)}">${esc(p.title)}</a></li>`).join('')}</ul></article></main></div></body></html>`;
}

export async function buildCommand(target, { out, comments = true, log = console.log } = {}) {
  const abs = path.resolve(target);
  if (!existsSync(abs)) throw new Error(`not found: ${target}`);
  const shown = (p) => (path.relative(process.cwd(), p).startsWith('..') ? p : path.relative(process.cwd(), p));
  const report = (dest, r) => {
    const rel = shown(dest);
    for (const e of r.errors) log(`  ⚠ couldn't resolve \`${e.info}\` (line ${e.line}): ${e.error}`);
    log(`${r.errors.length ? '✗' : '✓'} ${rel}${r.comments ? ` (${r.comments} comment thread${r.comments === 1 ? '' : 's'})` : ''}`);
  };

  if (!statSync(abs).isDirectory()) {
    const dest = path.resolve(out || `${path.basename(abs, '.md')}.html`);
    const r = await buildPage(abs, { comments });
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, r.html);
    report(dest, r);
    return r.errors.length ? 1 : 0;
  }

  // A directory of walks: one page per walk (same relative layout) plus an index.
  const destDir = path.resolve(out || 'code-walk-html');
  const list = [];
  let failed = 0;
  for (const file of await listWalks(abs)) {
    if (file.startsWith(destDir + path.sep)) continue;
    const rel = path.relative(abs, file).slice(0, -3).split(path.sep).join('/');
    const r = await buildPage(file, { name: rel, comments });
    const dest = path.join(destDir, `${rel}.html`);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, r.html);
    report(dest, r);
    list.push({ href: `${rel}.html`, title: rel });
    failed += r.errors.length;
  }
  const css = await readFile(path.join(WEB, 'app.css'), 'utf8');
  // A walk named `index` is the landing page already.
  if (!list.some((p) => p.href === 'index.html')) await writeFile(path.join(destDir, 'index.html'), indexPage({ css, list }));
  return failed ? 1 : 0;
}

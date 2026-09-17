// Markdown → HTML with git-referenced snippets.
import MarkdownIt from 'markdown-it';
import os from 'node:os';
import { parseRef, encodeFragment } from './refs.js';
import { parseOptions, resolveRef } from './resolve.js';
import { highlightLines, langForFence } from './highlight.js';
import { rowMatches } from './rows.js';
import { resolveStat } from './stats.js';

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function isRefInfo(info) {
  const first = (info || '').trim().split(/\s+/)[0];
  return first === 'show' || first === 'diff' || first === '-C';
}

function slugify(text, used) {
  let base = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  used.add(slug);
  return slug;
}

/**
 * Parse a walk body and resolve every reference block.
 * Returns { tokens, refs: [{ info, line, result?, error? }], title, toc }.
 */
export async function prepareWalk(walk, { highlight = true } = {}) {
  const tokens = md.parse(walk.body, {});
  const used = new Set();
  const toc = [];
  let title = walk.title;
  const refs = [];
  const jobs = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const inline = tokens[i + 1];
      const text = inline.children.filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
      const id = slugify(text, used);
      t.attrSet('id', id);
      const level = Number(t.tag.slice(1));
      if (level === 1 && !title) title = text;
      if (level === 2 || level === 3) toc.push({ level, text, id });
    }
    if (t.type !== 'fence') continue;
    const line = walk.bodyLineOffset + (t.map ? t.map[0] : 0) + 1;
    if (isRefInfo(t.info)) {
      const entry = { info: t.info.trim(), line };
      refs.push(entry);
      t.meta = entry;
      jobs.push((async () => {
        try {
          const ref = parseRef(entry.info);
          if (ref.stat) {
            entry.stat = await resolveStat(walk, ref, t.content);
            entry.warnings = entry.stat.warnings;
          } else {
            const options = parseOptions(t.content);
            entry.result = await resolveRef(walk, ref, { options, tokens: highlight });
          }
        } catch (e) {
          entry.error = e.message;
        }
      })());
    } else if (highlight && t.info.trim().split(/\s+/)[0] !== 'mermaid') {
      jobs.push((async () => {
        t.meta = { lines: await highlightLines(t.content.replace(/\n$/, ''), langForFence(t.info)) };
      })());
    }
  }
  await Promise.all(jobs);
  return { tokens, refs, title, toc };
}

md.renderer.rules.table_open = () => '<table class="cw-table">\n';

md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0];
  if (isRefInfo(t.info)) return renderRefBlock(t.meta);
  if (lang === 'mermaid') return `<div class="cw-mermaid"><pre class="mermaid">${esc(t.content)}</pre></div>\n`;
  const lines = t.meta?.lines;
  const body = lines ? lines.map((l) => renderTokens(l)).join('\n') : esc(t.content);
  return `<pre class="cw-pre"><code>${body}</code></pre>\n`;
};

// ---- reference blocks -------------------------------------------------------

let renderCtx = { walk: null };

export function renderWalkHtml(prepared, walk) {
  renderCtx = { walk };
  return md.renderer.render(prepared.tokens, md.options, {});
}

function renderRefBlock(entry) {
  if (entry.stat && !entry.error) return renderStat(entry.stat);
  if (entry.error || !entry.result) {
    return `<div class="cw-error" role="alert"><div class="cw-error-title">Couldn’t resolve <code>${esc(entry.info)}</code></div><div class="cw-error-msg">${esc(entry.error || 'unknown error')}</div></div>\n`;
  }
  const { result } = entry;
  let html = '';
  if (result.kind === 'commit') html += renderCommitCard(result);
  for (const s of result.sections) html += renderSection(result, s);
  return `<div class="cw-block">${html}</div>\n`;
}

function renderCommitCard(result) {
  const c = result.commit;
  const date = c.date ? new Date(c.date) : null;
  return `<div class="cw-commit">
  <div class="cw-commit-subject">${esc(c.subject)}</div>
  ${c.body ? `<div class="cw-commit-body">${esc(c.body)}</div>` : ''}
  <div class="cw-commit-meta">${repoLabel(result)}<span class="cw-side commit" title="${esc(c.sha)}"><i></i><code>${esc(c.sha.slice(0, 7))}</code></span><span>${esc(c.author)}</span>${date ? `<time datetime="${esc(c.date)}">${esc(date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }))}</time>` : ''}</div>
</div>`;
}

function repoLabel(result) {
  const walk = renderCtx.walk;
  if (!walk || (!walk.multiRepo && result.repo.isDefault)) return '';
  return `<span class="cw-repo" title="${esc(result.repo.root)}">${esc(result.repo.name)}</span>`;
}

function sideBadge(side) {
  if (side.type === 'index') return '<span class="cw-side index" title="The staged version (git index)"><i></i>STAGED</span>';
  if (side.type === 'worktree') return '<span class="cw-side worktree" title="The file on disk, including unstaged changes"><i></i>WORKING TREE</span>';
  const info = side.info || {};
  const title = [side.sha, info.subject, [info.author, info.date && info.date.slice(0, 10)].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
  const showRev = side.rev && !side.sha.startsWith(side.rev.toLowerCase()) && side.rev !== '(root)';
  const label = side.sha === '4b825dc642cb6eb9a060e54bf8d69288fbee4904' ? 'empty' : side.short;
  return `<span class="cw-side commit${side.mergeBase ? ' merge-base' : ''}" title="${esc(title)}"><i></i><code>${esc(label)}</code>${showRev ? `<span class="cw-rev">${esc(side.rev)}</span>` : ''}</span>`;
}

const STATUS = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied', M: null, T: 'type changed' };

function renderSection(result, s) {
  const walk = renderCtx.walk;
  let status = '';
  if (s.mode === 'diff') {
    const label = STATUS[s.status];
    if (label) status += `<span class="cw-status ${label.replace(' ', '-')}">${label}${(s.status === 'R' || s.status === 'C') ? ` from <code>${esc(s.oldPath)}</code>` : ''}</span>`;
    if (!s.binary) status += `<span class="cw-stat"><span class="add">+${s.added}</span><span class="del">−${s.removed}</span></span>`;
  }
  const sides = s.mode === 'diff'
    ? `${sideBadge(s.sides[0])}<span class="cw-arrow" aria-label="to">→</span>${sideBadge(s.sides[1])}`
    : sideBadge(s.sides[0]);
  const link = s.linkTokens.join(' ');
  const attrs = [
    `data-link="${esc(link)}"`,
    `data-frag="${esc(encodeFragment(s.linkTokens))}"`,
    `data-mode="${s.mode}"`,
    `data-repo="${esc(result.repo.root)}"`,
    `data-repo-name="${esc(result.repo.name)}"`,
    `data-path="${esc(s.path)}"`,
  ].join(' ');

  let body;
  if (s.binary) body = '<div class="cw-note">Binary file not shown</div>';
  else if (!s.rows.length) body = `<div class="cw-note">${s.mode === 'diff' ? (s.status === 'A' ? 'Empty file added' : s.status === 'D' ? 'Empty file deleted' : 'No content changes') : 'Empty file'}</div>`;
  else if (s.mode === 'diff' && !s.hunks.length && !s.span) body = '<div class="cw-note">No content changes</div>';
  else body = `<div class="cw-scroll"><table class="cw-code ${s.mode}">${renderRows(s)}</table></div>`;

  return `<figure class="cw-snippet" ${attrs}>
<figcaption class="cw-head">
  <div class="cw-head-row cw-title">${repoLabel(result)}<span class="cw-path">${esc(s.path)}</span>${status}<button class="cw-link-btn" type="button" title="Copy link to this snippet (y) · shift-click: copy for a prompt (Y)" aria-label="Copy link">${LINK_ICON}</button></div>
  <div class="cw-head-row cw-meta"><span class="cw-sides">${sides}</span><span class="cw-cmd"><code>${esc(s.displayCmd)}</code><button class="cw-copy-cmd" type="button" title="Copy command" aria-label="Copy command">${COPY_ICON}</button></span></div>
</figcaption>
${body}
</figure>\n`;
}

const LINK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.78 3.84a.75.75 0 0 1 0 1.06L5.9 6.78a2.25 2.25 0 0 0 3.18 3.18l.53-.53a.75.75 0 1 1 1.06 1.06l-.53.53a3.75 3.75 0 0 1-5.3-5.3l1.88-1.88a.75.75 0 0 1 1.06 0Zm.44 8.32a.75.75 0 0 1 0-1.06l1.88-1.88a2.25 2.25 0 0 0-3.18-3.18l-.53.53a.75.75 0 1 1-1.06-1.06l.53-.53a3.75 3.75 0 0 1 5.3 5.3l-1.88 1.88a.75.75 0 0 1-1.06 0Z"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M5.75 1h6.5C13.22 1 14 1.78 14 2.75v6.5c0 .97-.78 1.75-1.75 1.75H11v1.25c0 .97-.78 1.75-1.75 1.75h-6.5C1.78 14 1 13.22 1 12.25v-6.5C1 4.78 1.78 4 2.75 4H4V2.75C4 1.78 4.78 1 5.75 1Zm0 1.5a.25.25 0 0 0-.25.25v6.5c0 .14.11.25.25.25h6.5c.14 0 .25-.11.25-.25v-6.5a.25.25 0 0 0-.25-.25Zm-3 3a.25.25 0 0 0-.25.25v6.5c0 .14.11.25.25.25h6.5c.14 0 .25-.11.25-.25V11H5.75C4.78 11 4 10.22 4 9.25V5.5Z"/></svg>';

function visibleMask(s) {
  const mask = new Uint8Array(s.rows.length);
  if (s.span) mask.fill(1, s.span.start, s.span.end);
  else if (s.mode === 'diff') for (const h of s.hunks) mask.fill(1, h.start, h.end);
  else mask.fill(1);
  return mask;
}

function renderRows(s) {
  const mask = visibleMask(s);
  const out = [];
  let i = 0;
  const cols = s.mode === 'diff' ? 4 : 2;
  while (i < s.rows.length) {
    const vis = mask[i];
    let j = i;
    while (j < s.rows.length && mask[j] === vis) j++;
    const rows = [];
    for (let k = i; k < j; k++) rows.push(renderRow(s, s.rows[k]));
    if (vis) {
      out.push(`<tbody>${rows.join('')}</tbody>`);
    } else {
      const n = j - i;
      const where = i === 0 ? 'up' : j === s.rows.length ? 'down' : 'mid';
      out.push(`<tbody class="cw-fold ${where}"><tr class="cw-expander"><td colspan="${cols}"><button type="button">${EXPAND_ICON}<span>${n} ${s.mode === 'diff' ? 'unchanged ' : ''}line${n === 1 ? '' : 's'}</span></button></td></tr>${rows.join('')}</tbody>`);
    }
    i = j;
  }
  return out.join('');
}

const EXPAND_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="m8.177.677 2.896 2.896a.25.25 0 0 1-.177.427H8.75v1.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM7.25 10.75a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12H7.25v-1.25Zm-5-2a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z"/></svg>';

function renderRow(s, r) {
  const hl = s.highlight && s.highlight.some((spec) => rowMatches(r, spec, s.mode)) ? ' hl' : '';
  if (s.mode === 'file') {
    const toks = s.newTokens?.[r.n - 1];
    return `<tr class="r${hl}" data-l="${r.n}"><td class="ln" data-side="L">${r.n}</td><td class="code">${toks ? renderTokens(toks) : ''}</td></tr>`;
  }
  const cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx';
  const toks = r.t === '-' ? s.oldTokens?.[r.o - 1] : s.newTokens?.[r.n - 1];
  const mk = r.t === ' ' ? '' : r.t === '+' ? '+' : '−';
  return `<tr class="r ${cls}${hl}"${r.o ? ` data-l="${r.o}"` : ''}${r.n ? ` data-r="${r.n}"` : ''}><td class="ln" data-side="L">${r.o ?? ''}</td><td class="ln" data-side="R">${r.n ?? ''}</td><td class="mk">${mk}</td><td class="code">${toks ? renderTokens(toks, r.marks) : ''}</td></tr>`;
}

function renderTokens(tokens, marks) {
  let html = '';
  let pos = 0;
  let mi = 0;
  for (const tok of tokens) {
    const text = tok.content;
    const end = pos + text.length;
    let cursor = pos;
    // Split the token at word-diff mark boundaries.
    while (cursor < end) {
      while (marks && mi < marks.length && marks[mi][1] <= cursor) mi++;
      const m = marks && mi < marks.length ? marks[mi] : null;
      let segEnd;
      let marked = false;
      if (m && m[0] <= cursor) { segEnd = Math.min(end, m[1]); marked = true; }
      else if (m && m[0] < end) segEnd = m[0];
      else segEnd = end;
      const seg = text.slice(cursor - pos, segEnd - pos);
      const span = tok.style ? `<span style="${tok.style}">${esc(seg)}</span>` : esc(seg);
      html += marked ? `<mark>${span}</mark>` : span;
      cursor = segEnd;
    }
    pos = end;
  }
  return html;
}

// ---- page -------------------------------------------------------------------

export function tildify(p) {
  const home = os.homedir();
  return p && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

export function pageHtml({ title, toc, content, walk, walkName, hasMermaid }) {
  const tocHtml = toc.length
    ? `<nav class="cw-toc" aria-label="Contents"><div class="cw-toc-inner">${toc.map((h) => `<a class="l${h.level}" href="#${esc(h.id)}" data-id="${esc(h.id)}">${esc(h.text)}</a>`).join('')}</div></nav>`
    : '';
  const cfg = { walk: walkName, walkPath: walk.walkPath, multiRepo: walk.multiRepo };
  const bodyHasH1 = /^<h1[\s>]/.test(content.trimStart());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || walkName)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚶</text></svg>">
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<div class="cw-layout">
${tocHtml}
<main class="cw-main">
<header class="cw-header">
  ${title && !bodyHasH1 ? `<h1>${esc(title)}</h1>` : ''}
  <div class="cw-walkmeta">${walk.walkPath ? `<code>${esc(tildify(walk.walkPath))}</code>` : ''}${walk.repos.map((r) => `<span class="cw-repo-meta" title="${esc(r.path)}">${esc(r.name)}</span>`).join('')}</div>
</header>
<article class="cw-article">
${content}
</article>
</main>
</div>
<div class="cw-toast" role="status" aria-live="polite"></div>
<script>window.CODE_WALK = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};</script>
${hasMermaid ? '<script src="/assets/mermaid.min.js"></script>' : ''}
<script src="/assets/app.js"></script>
</body>
</html>`;
}

const commentMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
export function renderCommentBody(text) {
  return commentMd.render(String(text || ''));
}

// ---- --stat summaries -----------------------------------------------------------

const STATUS_LETTER = { A: 'A', D: 'D', R: 'R', C: 'C', M: 'M', T: 'T' };
const STATUS_WORD = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied', M: 'modified', T: 'type changed' };

/** GitHub-style five-square change bar. */
function changeBar(added, removed) {
  const total = added + removed;
  let green = total ? Math.round((5 * added) / total) : 0;
  let red = total ? 5 - green : 0;
  if (added && !green) { green = 1; red = 4; }
  if (removed && !red) { red = 1; green = 4; }
  const cells = [];
  for (let i = 0; i < 5; i++) cells.push(`<i class="${i < green ? 'add' : i < green + red ? 'del' : ''}"></i>`);
  return `<span class="cw-bar" aria-hidden="true">${cells.join('')}</span>`;
}

function counts(t) {
  return `<span class="cw-stat"><span class="add">+${t.added}</span><span class="del">−${t.removed}</span></span>`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderStat(stat) {
  const [oldSide, newSide] = stat.sides;
  const summary = [
    plural(stat.totals.count, 'file'),
    stat.commits != null ? plural(stat.commits, 'commit') : null,
  ].filter(Boolean).join(' · ');
  const title = stat.commit ? `<span class="cw-sum-subject">${esc(stat.commit.subject)}</span>` : '';

  const fileRow = (file) => {
    const rename = (file.status === 'R' || file.status === 'C') && file.oldPath !== file.path
      ? `<span class="cw-sum-rename">from <code>${esc(file.oldPath)}</code></span>` : '';
    return `<tr class="cw-sum-file" data-path="${esc(file.path)}">
      <td class="cw-sum-status"><span class="s-${esc(file.status)}" title="${esc(STATUS_WORD[file.status] || file.status)}">${esc(STATUS_LETTER[file.status] || file.status)}</span></td>
      <td class="cw-sum-name"><span class="cw-sum-path">${esc(file.path)}</span>${rename}${file.note ? `<div class="cw-sum-note">${esc(file.note)}</div>` : ''}</td>
      <td class="cw-sum-counts">${file.binary ? '<span class="cw-sum-binary">binary</span>' : counts(file)}</td>
      <td class="cw-sum-barcell">${file.binary ? '' : changeBar(file.added, file.removed)}</td>
    </tr>`;
  };

  let body = '';
  for (const g of stat.groups) {
    if (stat.grouped) {
      body += `<tbody class="cw-sum-group${g.implicit ? ' implicit' : ''}"><tr class="cw-sum-grouphead">
        <td colspan="2"><span class="cw-sum-groupname">${esc(g.name)}</span>${g.note ? `<span class="cw-sum-groupnote">${esc(g.note)}</span>` : ''}${g.implicit ? '<span class="cw-sum-groupnote">not matched by any group</span>' : ''}<span class="cw-sum-groupcount">${plural(g.count, 'file')}</span></td>
        <td class="cw-sum-counts">${counts(g)}</td>
        <td class="cw-sum-barcell">${changeBar(g.added, g.removed)}</td>
      </tr>${g.files.map(fileRow).join('')}</tbody>`;
    } else {
      body += `<tbody>${g.files.map(fileRow).join('')}</tbody>`;
    }
  }
  const footer = stat.grouped && stat.groups.length > 1
    ? `<tfoot><tr class="cw-sum-total"><td colspan="2">Total <span class="cw-sum-groupcount">${plural(stat.totals.count, 'file')}</span></td><td class="cw-sum-counts">${counts(stat.totals)}</td><td class="cw-sum-barcell">${changeBar(stat.totals.added, stat.totals.removed)}</td></tr></tfoot>`
    : '';
  const warnings = stat.warnings.length
    ? `<div class="cw-sum-warnings">${stat.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : '';
  const empty = stat.files.length ? '' : '<div class="cw-note">No changes</div>';
  const repoTag = renderCtx.walk && (renderCtx.walk.multiRepo || !stat.repo.isDefault)
    ? `<span class="cw-repo" title="${esc(stat.repo.root)}">${esc(stat.repo.name)}</span>` : '';

  return `<div class="cw-block"><section class="cw-summary" data-repo="${esc(stat.repo.root)}">
<header class="cw-head">
  <div class="cw-head-row cw-title">${repoTag}<span class="cw-sum-headline">${summary}</span>${counts(stat.totals)}${changeBar(stat.totals.added, stat.totals.removed)}${title}</div>
  <div class="cw-head-row cw-meta"><span class="cw-sides">${sideBadge(oldSide)}<span class="cw-arrow" aria-label="to">→</span>${sideBadge(newSide)}</span><span class="cw-cmd"><code>${esc(stat.displayCmd)}</code><button class="cw-copy-cmd" type="button" title="Copy command" aria-label="Copy command">${COPY_ICON}</button></span></div>
</header>
${empty}${stat.files.length ? `<div class="cw-scroll"><table class="cw-sum">${body}${footer}</table></div>` : ''}${warnings}
</section></div>\n`;
}

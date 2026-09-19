(() => {
  const CFG = window.CODE_WALK || {};
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const SEL_RE = /^(?:([LR])(\d+)(?:-([LR])?(\d+))?|hunk=(\d+))$/;

  // ---- toast ------------------------------------------------------------------
  const toastEl = document.querySelector('.cw-toast');
  let toastTimer;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg);
  }

  // ---- live reload (keeps scroll position) -------------------------------------
  const SCROLL_KEY = `cw-scroll:${location.pathname}`;
  try {
    const y = sessionStorage.getItem(SCROLL_KEY);
    if (y !== null) {
      sessionStorage.removeItem(SCROLL_KEY);
      history.scrollRestoration = 'manual';
      window.__cwRestored = Number(y);
    }
  } catch { /* storage unavailable */ }

  if (window.EventSource) {
    const es = new EventSource('/events');
    es.onmessage = (ev) => {
      let data = {};
      try { data = JSON.parse(ev.data); } catch { return; }
      if (data.kind === 'comments') {
        if (data.walk === CFG.walk) loadComments();
        return;
      }
      if (!CFG.walk || data.walk === CFG.walk) {
        try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch { /* ignore */ }
        location.reload();
      }
    };
  }

  // ---- mermaid -------------------------------------------------------------------
  let layoutReady = Promise.resolve();
  if (window.mermaid) {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const css = getComputedStyle(document.documentElement);
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'neutral',
      fontFamily: css.getPropertyValue('--font').trim(),
    });
    layoutReady = window.mermaid.run({ querySelector: 'pre.mermaid' }).catch((e) => console.error(e));
  }

  // ---- folds ------------------------------------------------------------------------
  function openFold(node) {
    const fold = node.closest('.cw-fold');
    if (!fold) return;
    fold.classList.add('open');
    fold.querySelector('.cw-expander button')?.setAttribute('aria-expanded', 'true');
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.cw-expander button');
    if (!btn) return;
    const open = btn.closest('.cw-fold').classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });

  // ---- line selection ---------------------------------------------------------------
  let current = null; // { fig, anchor: {idx, side}, focus: {idx, side} }

  const rowsOf = (fig) => $$('tr.r', fig);

  function lineOf(row, side, mode) {
    const v = row.dataset[side === 'L' ? 'l' : 'r'];
    return v === undefined ? null : Number(v);
  }

  function pickSide(row, preferred, mode) {
    if (mode === 'file') return 'L';
    if (lineOf(row, preferred) !== null) return preferred;
    return preferred === 'L' ? 'R' : 'L';
  }

  function rangeFor(fig, a, b) {
    const rows = rowsOf(fig);
    const mode = fig.dataset.mode;
    let [s, e] = a.idx <= b.idx ? [a, b] : [b, a];
    const sr = rows[s.idx];
    const er = rows[e.idx];
    if (mode === 'file') {
      const x = lineOf(sr, 'L');
      const y = lineOf(er, 'L');
      return x === y ? `L${x}` : `L${x}-${y}`;
    }
    const has = (row, side) => lineOf(row, side) !== null;
    let ss = s.side;
    let es = e.side;
    const valid = (p, q) => has(sr, p) && has(er, q) && !(p === 'R' && q === 'L');
    if (!valid(ss, es)) {
      const options = [['L', 'L'], ['R', 'R'], ['L', 'R']];
      const found = options.find(([p, q]) => valid(p, q));
      if (found) [ss, es] = found;
      else {
        // Added lines followed by deleted lines: fall back to the new side.
        ss = 'R';
        es = 'R';
        let j = e.idx;
        while (j > s.idx && !has(rows[j], 'R')) j--;
        e = { idx: j };
      }
    }
    const x = lineOf(sr, ss);
    const y = lineOf(rows[e.idx], es);
    if (ss === es) return x === y ? `${ss}${x}` : `${ss}${x}-${y}`;
    return `${ss}${x}-${es}${y}`;
  }

  /** Mirrors selectionSpan() on the server. Returns {start, end} (end exclusive) or null. */
  function spanFor(fig, range) {
    const m = SEL_RE.exec(range);
    if (!m || m[5]) return null;
    const rows = rowsOf(fig);
    const mode = fig.dataset.mode;
    const s = { side: mode === 'file' ? 'L' : m[1], line: Number(m[2]) };
    const e = m[4] ? { side: mode === 'file' ? 'L' : (m[3] || m[1]), line: Number(m[4]) } : { ...s };
    let start = -1;
    let end = -1;
    if (s.side === e.side) {
      rows.forEach((r, i) => {
        const ln = lineOf(r, s.side);
        if (ln !== null && ln >= s.line && ln <= e.line) {
          if (start === -1) start = i;
          end = i;
        }
      });
    } else {
      start = rows.findIndex((r) => lineOf(r, s.side) === s.line);
      for (let i = rows.length - 1; i >= 0; i--) if (lineOf(rows[i], e.side) === e.line) { end = i; break; }
    }
    if (start === -1 || end === -1 || end < start) return null;
    return { start, end: end + 1 };
  }

  function clearSelection() {
    $$('tr.sel').forEach((r) => r.classList.remove('sel'));
    current = null;
    onSelectionChange();
  }

  function paint(fig, span, { reveal = false, flash = false } = {}) {
    $$('tr.sel').forEach((r) => r.classList.remove('sel'));
    const rows = rowsOf(fig);
    for (let i = span.start; i < span.end; i++) {
      const r = rows[i];
      r.classList.add('sel');
      openFold(r);
      if (flash) {
        r.classList.remove('flash');
        void r.offsetWidth;
        r.classList.add('flash');
      }
    }
    onSelectionChange();
    if (reveal) {
      const first = rows[span.start];
      const rect = first.getBoundingClientRect();
      const target = window.scrollY + rect.top - Math.max(80, window.innerHeight * 0.3);
      window.scrollTo({ top: Math.max(0, target), behavior: 'instant' in window ? 'instant' : 'auto' });
    }
  }

  function snippetUrl(fig, range) {
    const frag = fig.dataset.frag + (range ? `&${range}` : '');
    return `${location.origin}${location.pathname}#${frag}`;
  }

  function updateUrl(fig, range) {
    history.replaceState(null, '', `#${fig.dataset.frag}${range ? `&${range}` : ''}`);
  }

  document.addEventListener('click', (e) => {
    const cell = e.target.closest('.cw-code td.ln');
    if (!cell) return;
    const fig = cell.closest('.cw-snippet');
    const row = cell.closest('tr.r');
    const rows = rowsOf(fig);
    const idx = rows.indexOf(row);
    const side = pickSide(row, cell.dataset.side, fig.dataset.mode);
    if (!current || current.fig !== fig || !e.shiftKey) {
      if (current && current.fig === fig && current.anchor.idx === idx && current.focus.idx === idx && !e.shiftKey) {
        clearSelection();
        history.replaceState(null, '', location.pathname);
        return;
      }
      current = { fig, anchor: { idx, side }, focus: { idx, side } };
    } else {
      current.focus = { idx, side };
      window.getSelection()?.removeAllRanges();
    }
    const range = rangeFor(fig, current.anchor, current.focus);
    const span = spanFor(fig, range);
    if (span) paint(fig, span);
    current.range = range;
    updateUrl(fig, range);
    onSelectionChange();
  });

  function decodeFragment(hash) {
    let frag = hash.replace(/^#/, '');
    let range = null;
    const amp = frag.lastIndexOf('&');
    if (amp !== -1 && SEL_RE.test(frag.slice(amp + 1))) {
      range = frag.slice(amp + 1);
      frag = frag.slice(0, amp);
    }
    let tokens;
    try {
      tokens = frag.split('+').filter(Boolean).map((t) => decodeURIComponent(t));
    } catch {
      return null;
    }
    return { tokens, range };
  }

  function findSnippet(link, range) {
    const strip = (s) => s.replace(/^-C \S+ /, '');
    const figs = $$('.cw-snippet');
    let matches = figs.filter((f) => f.dataset.link === link);
    if (!matches.length) matches = figs.filter((f) => strip(f.dataset.link) === strip(link));
    // Prefer a snippet that already shows the lines without expanding folds.
    return matches.find((f) => {
      const span = range && spanFor(f, range);
      return span && rowsOf(f).slice(span.start, span.end).every((r) => !r.closest('.cw-fold'));
    }) || matches.find((f) => range && spanFor(f, range)) || (range ? null : matches[0]) || null;
  }

  function applyHash({ flash = true } = {}) {
    const cm = /^#comment-([0-9a-f]+)$/.exec(location.hash);
    if (cm) return commentsReady.then(() => focusThread(cm[1]));
    const hash = location.hash;
    if (!hash || document.getElementById(decodeURIComponent(hash.slice(1)))) return;
    const d = decodeFragment(hash);
    if (!d || !d.tokens.length || !['show', 'diff', '-C'].includes(d.tokens[0])) return;
    const fig = findSnippet(d.tokens.join(' '), d.range);
    if (!fig) {
      toast('That snippet isn’t in this walk');
      return;
    }
    if (!d.range) {
      fig.scrollIntoView({ block: 'start' });
      return;
    }
    const span = spanFor(fig, d.range);
    if (!span) {
      toast(`Lines ${d.range} aren’t shown in that snippet`);
      fig.scrollIntoView({ block: 'start' });
      return;
    }
    const rows = rowsOf(fig);
    const sideOf = (r, pref) => pickSide(r, pref, fig.dataset.mode);
    const m = SEL_RE.exec(d.range);
    current = {
      fig,
      anchor: { idx: span.start, side: sideOf(rows[span.start], m[1]) },
      focus: { idx: span.end - 1, side: sideOf(rows[span.end - 1], m[3] || m[1]) },
      range: d.range,
    };
    paint(fig, span, { reveal: window.__cwRestored === undefined, flash });
  }

  window.addEventListener('hashchange', () => applyHash());
  // Wait for diagrams to take their final size so scroll positions are stable.
  layoutReady.then(() => {
    if (window.__cwRestored !== undefined) window.scrollTo(0, window.__cwRestored);
    applyHash({ flash: window.__cwRestored === undefined });
  });

  // ---- copying ----------------------------------------------------------------------
  function sectionTitle(fig) {
    let title = null;
    for (const h of $$('.cw-article h1, .cw-article h2, .cw-article h3')) {
      if (h.compareDocumentPosition(fig) & Node.DOCUMENT_POSITION_FOLLOWING) title = h.textContent.trim();
      else break;
    }
    return title;
  }

  function promptText(fig, range) {
    const tokens = fig.dataset.link.replace(/^-C \S+ /, '');
    const repo = fig.dataset.repo;
    const lines = range ? ` lines ${range}` : '';
    const where = [
      CFG.walkPath ? `walk: ${CFG.walkPath}` : null,
      sectionTitle(fig) ? `section "${sectionTitle(fig)}"` : null,
    ].filter(Boolean).join(', ');
    let ref;
    if (/^show [^:\s]+$/.test(tokens)) ref = `${fig.dataset.path}${lines} (working tree of ${repo})`;
    else ref = `\`git -C ${repo} ${tokens}\`${lines}${range && fig.dataset.mode === 'diff' ? ' (L = old side, R = new side)' : ''}`;
    return `${ref}${where ? `\n${where}` : ''}\n${snippetUrl(fig, range)}`;
  }

  function copyLink(fig, forPrompt) {
    const range = current && current.fig === fig ? current.range : null;
    if (forPrompt) copy(promptText(fig, range), 'Copied reference for a prompt');
    else copy(snippetUrl(fig, range), range ? `Copied link to ${range}` : 'Copied link to snippet');
  }

  document.addEventListener('click', (e) => {
    const linkBtn = e.target.closest('.cw-link-btn');
    if (linkBtn) return copyLink(linkBtn.closest('.cw-snippet'), e.shiftKey);
    const cmdBtn = e.target.closest('.cw-copy-cmd');
    if (cmdBtn) {
      const code = cmdBtn.parentElement.querySelector('code');
      copy(code.textContent, 'Copied command');
    }
  });

  // ---- keyboard ---------------------------------------------------------------------
  const headings = () => $$('.cw-article h2, .cw-article h3');

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'c') {
      e.preventDefault();
      openComposer();
    } else if (e.key === 'n' || e.key === 'p') {
      jumpToThread(e.key === 'n' ? 1 : -1);
    } else if (e.key === 'y' || e.key === 'Y') {
      if (!current) return toast('Click a line number to select lines first');
      copyLink(current.fig, e.key === 'Y');
    } else if (e.key === 'j' || e.key === 'k') {
      const hs = headings();
      if (!hs.length) return;
      const y = 30;
      let target;
      if (e.key === 'j') target = hs.find((h) => h.getBoundingClientRect().top > y + 1);
      else target = [...hs].reverse().find((h) => h.getBoundingClientRect().top < y - 1);
      if (target) target.scrollIntoView({ block: 'start' });
      else if (e.key === 'k') window.scrollTo({ top: 0 });
    } else if (e.key === 'Escape' && current) {
      clearSelection();
      history.replaceState(null, '', location.pathname);
    }
  });

  // ---- --stat summaries: files shown elsewhere in the walk link to their snippet --------
  for (const row of $$('.cw-sum-file')) {
    const repo = row.closest('.cw-summary').dataset.repo;
    const target = $$('.cw-snippet').find((f) => f.dataset.repo === repo && f.dataset.path === row.dataset.path);
    if (!target) continue;
    const label = row.querySelector('.cw-sum-path');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cw-sum-path';
    btn.title = 'Jump to this file in the walk';
    btn.textContent = label.textContent;
    btn.addEventListener('click', () => {
      target.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -24);
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
    });
    label.replaceWith(btn);
  }

  // ---- review comments -----------------------------------------------------------------
  // Threads are stored by the server in <walk>.comments.json and anchored to a snippet's
  // link + line range, with a copy of the lines, so Claude can act on them via the CLI.
  // editBase: the text each open editor started from. Saves send it so the server can refuse to
  // overwrite a message that changed meanwhile (e.g. Claude edited it from the CLI).
  const review = { me: 'You', comments: [], drafts: new Map(), replying: new Set(), editing: new Set(), editBase: new Map(), loaded: false };
  let resolveCommentsReady;
  const commentsReady = new Promise((r) => { resolveCommentsReady = r; });

  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  async function api(action, { id, body } = {}) {
    const q = new URLSearchParams({ walk: CFG.walk });
    if (id) q.set('id', id);
    const res = await fetch(`/api/comments${action}?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `request failed (${res.status})`), { status: res.status, data });
    return data;
  }

  async function loadComments() {
    if (!CFG.walk) return;
    try {
      const res = await fetch(`/api/comments?walk=${encodeURIComponent(CFG.walk)}`);
      if (!res.ok) return;
      const data = await res.json();
      review.me = data.me || 'You';
      review.comments = data.comments || [];
      review.loaded = true;
      renderThreads();
    } catch (e) {
      console.error(e);
    } finally {
      resolveCommentsReady();
    }
  }

  function anchorFor(fig, range) {
    const span = spanFor(fig, range);
    const rows = rowsOf(fig).slice(span.start, span.end);
    const file = fig.dataset.mode === 'file';
    return {
      link: fig.dataset.link,
      range,
      path: fig.dataset.path,
      mode: fig.dataset.mode,
      repo: fig.dataset.repo,
      repoName: fig.dataset.repoName,
      command: fig.dataset.link,
      section: sectionTitle(fig),
      lines: rows.map((r) => ({
        o: !file && r.dataset.l ? Number(r.dataset.l) : null,
        n: file ? Number(r.dataset.l) : r.dataset.r ? Number(r.dataset.r) : null,
        t: r.classList.contains('add') ? '+' : r.classList.contains('del') ? '-' : ' ',
        text: r.querySelector('.code').textContent,
      })),
    };
  }

  // -- selection toolbar --
  const selbar = el('div', 'cw-selbar');
  selbar.setAttribute('role', 'toolbar');
  document.body.appendChild(selbar);

  function onSelectionChange() {
    if (!current || !current.range || !CFG.walk) {
      selbar.classList.remove('show');
      document.body.classList.remove('has-selbar');
      return;
    }
    selbar.innerHTML = `<span class="cw-selbar-range"><code>${escHtml(current.fig.dataset.path.split('/').pop())}</code> ${escHtml(current.range)}</span>`
      + '<button type="button" data-act="comment">Comment <kbd>c</kbd></button>'
      + '<button type="button" data-act="link">Copy link <kbd>y</kbd></button>'
      + '<button type="button" data-act="clear" aria-label="Clear selection" title="Clear selection (Esc)">✕</button>';
    selbar.classList.add('show');
    document.body.classList.add('has-selbar');
  }

  selbar.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'comment') openComposer();
    else if (act === 'link' && current) copyLink(current.fig, e.shiftKey);
    else if (act === 'clear') {
      clearSelection();
      history.replaceState(null, '', location.pathname);
    }
  });

  // -- composer for a new comment --
  let composer = null; // { fig, range, row }

  function closeComposer() {
    composer?.row.remove();
    composer = null;
  }

  function openComposer() {
    if (!current || !current.range) return toast('Select lines first: click a line number (shift-click for a range)');
    const { fig, range } = current;
    const span = spanFor(fig, range);
    if (!span) return;
    if (composer && composer.fig === fig && composer.range === range) {
      composer.row.querySelector('textarea').focus();
      return;
    }
    closeComposer();
    const rows = rowsOf(fig);
    const cols = rows[0].children.length;
    const row = el('tr', 'cw-comment-row cw-composer-row');
    const td = el('td');
    td.colSpan = cols;
    td.innerHTML = `<div class="cw-composer">
      <div class="cw-composer-head">Comment on <b>${escHtml(range)}</b></div>
      <textarea rows="3" placeholder="Leave a review comment… (Markdown supported)"></textarea>
      <div class="cw-composer-actions"><span class="cw-hint">⌘↩ to save · Esc to cancel</span><button type="button" class="cw-btn" data-act="cancel">Cancel</button><button type="button" class="cw-btn primary" data-act="save">Comment</button></div>
    </div>`;
    row.appendChild(td);
    rows[span.end - 1].after(row);
    composer = { fig, range, row };
    const ta = td.querySelector('textarea');
    ta.value = review.drafts.get('new') || '';
    ta.focus();
  }

  async function saveComposer() {
    if (!composer) return;
    const ta = composer.row.querySelector('textarea');
    const body = ta.value.trim();
    if (!body) return ta.focus();
    const btn = composer.row.querySelector('[data-act="save"]');
    btn.disabled = true;
    try {
      const { comment } = await api('', { body: { anchor: anchorFor(composer.fig, composer.range), body } });
      review.drafts.delete('new');
      closeComposer();
      const first = !review.comments.length;
      review.comments.push(comment);
      renderThreads();
      toast(first ? 'Comment saved. When you’re done, ask Claude to “address my code walk comments”' : 'Comment saved');
    } catch (e) {
      btn.disabled = false;
      toast(e.message);
    }
  }

  // -- thread rendering --
  function avatar(name) {
    const claude = /^claude$/i.test(name);
    return `<span class="cw-avatar${claude ? ' claude' : ''}" aria-hidden="true">${claude ? '✳' : escHtml((name || '?').trim().charAt(0).toUpperCase())}</span>`;
  }

  // A message key is the thread id, or "<thread id>/<reply id>" for a reply.
  function messageHtml(m, { id, isRoot }) {
    const key = isRoot ? id : `${id}/${m.id}`;
    const k = escHtml(key);
    const editing = review.editing.has(key);
    const what = !isRoot ? 'reply' : m.replies?.length ? 'thread' : 'comment';
    const menu = review.confirmingDelete === key
      ? `<span class="cw-msg-menu confirming"><span class="cw-confirm-text">Delete ${what}?</span><button type="button" class="danger" data-act="confirm-delete" data-key="${k}">Delete</button><button type="button" data-act="cancel-delete">Cancel</button></span>`
      : `<span class="cw-msg-menu"><button type="button" data-act="edit" data-key="${k}">Edit</button><button type="button" data-act="delete" data-key="${k}"${what === 'thread' ? ' title="Deletes the whole thread"' : ''}>Delete</button></span>`;
    return `<div class="cw-msg${isRoot ? '' : ' reply'}" data-key="${k}">
      ${avatar(m.author)}
      <div class="cw-msg-main">
        <div class="cw-msg-meta"><b>${escHtml(m.author)}</b><time datetime="${escHtml(m.created)}" title="${escHtml(new Date(m.created).toLocaleString())}">${ago(m.created)}</time>${m.edited ? '<span class="cw-edited">edited</span>' : ''}${menu}</div>
        ${editing
          ? `<div class="cw-composer inline edit">${conflictHtml(key, m)}<textarea rows="1" data-draft="edit:${k}"></textarea></div>`
          : `<div class="cw-msg-body">${m.bodyHtml}</div>`}
      </div>
    </div>`;
  }

  /** Shown in an open editor when the message changed after editing started. */
  function conflictHtml(key, m) {
    const base = review.editBase.get(key);
    if (base === undefined || base === m.body) return '';
    const k = escHtml(key);
    return `<div class="cw-conflict" role="alert">
      <div class="cw-conflict-head">This message changed while you were editing. Your text below hasn’t been saved.</div>
      <div class="cw-conflict-label">Latest version</div>
      <div class="cw-conflict-current">${escHtml(m.body)}</div>
      <div class="cw-conflict-actions"><button type="button" class="cw-btn ghost save" data-act="keep-mine" data-key="${k}">Save mine anyway</button><button type="button" class="cw-btn ghost" data-act="take-latest" data-key="${k}">Edit the latest instead</button></div>
    </div>`;
  }

  function threadEl(c, { quote = false } = {}) {
    const resolved = c.status === 'resolved';
    const expanded = !resolved || review.expanded?.has(c.id);
    const node = el('div', `cw-thread${resolved ? ' resolved' : ''}${expanded ? '' : ' collapsed'}`);
    node.id = `comment-${c.id}`;
    node.dataset.id = c.id;
    const a = c.anchor || {};
    const summary = (c.body || '').split('\n')[0].slice(0, 120);
    let html = '';
    if (resolved) {
      html += `<button type="button" class="cw-thread-toggle" data-act="toggle"><span class="cw-check">✓</span> Resolved${expanded ? '' : ` · <span class="cw-thread-summary">${escHtml(summary)}</span>`}<span class="cw-thread-count">${c.replies.length ? `${c.replies.length + 1} messages` : ''}</span></button>`;
    }
    if (expanded) {
      if (quote) {
        html += `<div class="cw-quote"><div class="cw-quote-head"><code>${escHtml(a.path || '')}</code> ${escHtml(a.range || '')}${a.section ? ` · ${escHtml(a.section)}` : ''}</div><pre>${(a.lines || []).map((l) => `<span class="${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}">${escHtml(l.t === ' ' ? '  ' : `${l.t} `)}${escHtml(l.text)}</span>`).join('\n')}</pre></div>`;
      }
      html += messageHtml(c, { id: c.id, isRoot: true });
      for (const r of c.replies) html += messageHtml(r, { id: c.id, isRoot: false });
      // While a message is being edited, its Cancel / Save take the place of Reply / Resolve.
      const editKey = [...review.editing].find((key) => key === c.id || key.startsWith(`${c.id}/`));
      if (editKey) {
        node.classList.add('editing');
        const k = escHtml(editKey);
        html += `<div class="cw-thread-actions editing"><button type="button" class="cw-btn ghost" data-act="cancel-edit" data-key="${k}">Cancel</button><button type="button" class="cw-btn ghost save" data-act="save-edit" data-key="${k}">Save</button><span class="cw-hint">⌘↩ to save · Esc to cancel</span></div>`;
      } else if (review.replying.has(c.id)) {
        html += `<div class="cw-composer inline reply"><textarea rows="2" placeholder="Reply…" data-draft="reply:${c.id}"></textarea><div class="cw-composer-actions"><span class="cw-hint">⌘↩ to send</span><button type="button" class="cw-btn" data-act="cancel-reply">Cancel</button><button type="button" class="cw-btn primary" data-act="send-reply">Reply</button></div></div>`;
      } else {
        html += `<div class="cw-thread-actions"><button type="button" class="cw-btn ghost" data-act="reply">Reply</button><button type="button" class="cw-btn ghost" data-act="${resolved ? 'reopen' : 'resolve'}">${resolved ? 'Reopen' : 'Resolve'}</button><button type="button" class="cw-btn ghost cw-thread-link" data-act="copy-link" title="Copy link to this comment">Link</button></div>`;
      }
    }
    node.innerHTML = html;
    return node;
  }

  function renderThreads() {
    // Keep drafts and focus across re-renders (e.g. when Claude replies from the CLI).
    const active = document.activeElement;
    const activeKey = active?.dataset?.draft;
    const caret = activeKey ? [active.selectionStart, active.selectionEnd] : null;
    $$('textarea[data-draft]').forEach((t) => review.drafts.set(t.dataset.draft, t.value));
    if (composer) review.drafts.set('new', composer.row.querySelector('textarea').value);

    $$('.cw-thread-row, .cw-unplaced').forEach((n) => n.remove());
    $$('tr.commented').forEach((r) => r.classList.remove('commented', 'resolved-only'));

    const groups = new Map();
    const unplaced = [];
    for (const c of review.comments) {
      const a = c.anchor;
      const fig = a && a.link && a.range ? findSnippet(a.link, a.range) : null;
      const span = fig && spanFor(fig, a.range);
      if (!span) { unplaced.push(c); continue; }
      const rows = rowsOf(fig);
      const endRow = rows[span.end - 1];
      if (!groups.has(endRow)) groups.set(endRow, []);
      groups.get(endRow).push(c);
      for (let i = span.start; i < span.end; i++) {
        const r = rows[i];
        if (c.status !== 'resolved') {
          r.classList.add('commented');
          r.classList.remove('resolved-only');
          openFold(r);
        } else if (!r.classList.contains('commented')) {
          r.classList.add('commented', 'resolved-only');
        }
      }
    }
    for (const [endRow, list] of groups) {
      const tr = el('tr', 'cw-comment-row cw-thread-row');
      const td = el('td');
      td.colSpan = endRow.children.length;
      const wrap = el('div', 'cw-threads');
      list.forEach((c) => wrap.appendChild(threadEl(c)));
      td.appendChild(wrap);
      tr.appendChild(td);
      endRow.after(tr);
    }
    if (unplaced.length) {
      const sec = el('section', 'cw-unplaced');
      sec.innerHTML = '<h2>Comments on code no longer in this walk</h2>';
      unplaced.forEach((c) => sec.appendChild(threadEl(c, { quote: true })));
      document.querySelector('.cw-article')?.appendChild(sec);
    }

    for (const [key, value] of review.drafts) {
      const t = document.querySelector(`textarea[data-draft="${CSS.escape(key)}"]`);
      if (t) t.value = value;
    }
    for (const key of review.editing) {
      const t = document.querySelector(`textarea[data-draft="edit:${CSS.escape(key)}"]`);
      const m = messageFor(key);
      if (t && !review.drafts.has(`edit:${key}`) && m) t.value = m.body;
    }
    $$('.cw-composer textarea').forEach(autosize);
    if (activeKey) {
      const t = document.querySelector(`textarea[data-draft="${CSS.escape(activeKey)}"]`);
      if (t) { t.focus({ preventScroll: true }); if (caret) t.setSelectionRange(caret[0], caret[1]); }
    }
  }

  /** Grow a textarea to fit its content so the whole comment is visible while editing. */
  function autosize(t) {
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight + (t.offsetHeight - t.clientHeight)}px`;
  }

  function messageFor(key) {
    const [id, replyId] = key.split('/');
    const c = review.comments.find((x) => x.id === id);
    return c && (replyId ? c.replies.find((r) => r.id === replyId) : c);
  }

  // -- thread actions --
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.cw-thread button, .cw-composer-row button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'cancel') { review.drafts.delete('new'); return closeComposer(); }
    if (act === 'save') return saveComposer();
    const thread = btn.closest('.cw-thread');
    if (!thread) return;
    const id = thread.dataset.id;
    const c = review.comments.find((x) => x.id === id);
    const replace = (updated) => {
      const i = review.comments.findIndex((x) => x.id === id);
      if (i !== -1) review.comments[i] = updated;
    };
    try {
      if (act === 'toggle') {
        review.expanded ??= new Set();
        if (review.expanded.has(id)) review.expanded.delete(id); else review.expanded.add(id);
        renderThreads();
      } else if (act === 'reply') {
        review.replying.add(id);
        renderThreads();
        document.querySelector(`textarea[data-draft="reply:${CSS.escape(id)}"]`)?.focus();
      } else if (act === 'cancel-reply') {
        review.replying.delete(id);
        review.drafts.delete(`reply:${id}`);
        renderThreads();
      } else if (act === 'send-reply') {
        const t = thread.querySelector(`textarea[data-draft="reply:${CSS.escape(id)}"]`);
        if (!t.value.trim()) return t.focus();
        btn.disabled = true;
        const { comment } = await api('/reply', { id, body: { body: t.value } });
        review.replying.delete(id);
        review.drafts.delete(`reply:${id}`);
        replace(comment);
        renderThreads();
      } else if (act === 'resolve' || act === 'reopen') {
        const { comment } = await api('/status', { id, body: { status: act === 'resolve' ? 'resolved' : 'open' } });
        replace(comment);
        review.expanded?.delete(id);
        renderThreads();
        toast(act === 'resolve' ? 'Resolved' : 'Reopened');
      } else if (act === 'edit') {
        const key = btn.dataset.key;
        // One message per thread at a time, since the thread's action row holds its Save / Cancel.
        for (const other of [...review.editing]) if (other.split('/')[0] === id) review.editing.delete(other);
        review.replying.delete(id);
        review.editing.add(key);
        review.editBase.set(key, messageFor(key)?.body ?? '');
        renderThreads();
        const t = document.querySelector(`textarea[data-draft="edit:${CSS.escape(key)}"]`);
        // Keep the page still: the editor takes the text's place and shows all of it.
        if (t) { t.focus({ preventScroll: true }); t.setSelectionRange(t.value.length, t.value.length); }
      } else if (act === 'cancel-edit') {
        const key = btn.dataset.key;
        review.editing.delete(key);
        review.editBase.delete(key);
        review.drafts.delete(`edit:${key}`);
        renderThreads();
      } else if (act === 'keep-mine') {
        // The user has now seen the latest text, so it becomes the base for their save.
        const key = btn.dataset.key;
        review.editBase.set(key, messageFor(key)?.body ?? '');
        thread.querySelector(`[data-act="save-edit"][data-key="${CSS.escape(key)}"]`)?.click();
      } else if (act === 'take-latest') {
        const key = btn.dataset.key;
        const latest = messageFor(key)?.body ?? '';
        review.editBase.set(key, latest);
        review.drafts.set(`edit:${key}`, latest);
        thread.querySelector(`textarea[data-draft="edit:${CSS.escape(key)}"]`).value = latest;
        renderThreads();
      } else if (act === 'save-edit') {
        const key = btn.dataset.key;
        const t = thread.querySelector(`textarea[data-draft="edit:${CSS.escape(key)}"]`);
        if (!t.value.trim()) return t.focus();
        btn.disabled = true;
        try {
          const { comment } = await api('/edit', { id, body: { body: t.value, reply: key.split('/')[1] || null, base: review.editBase.get(key) } });
          review.editing.delete(key);
          review.editBase.delete(key);
          review.drafts.delete(`edit:${key}`);
          replace(comment);
        } catch (err) {
          if (err.status !== 409) throw err;
          // Someone else changed it: keep the draft, show their latest text, let the user choose.
          const m = messageFor(key);
          if (m) m.body = err.data.current;
          toast('Not saved: this message changed while you were editing');
        }
        renderThreads();
      } else if (act === 'delete') {
        // Inline confirmation: native confirm() is blocked in some embedded browsers.
        review.confirmingDelete = btn.dataset.key;
        renderThreads();
        document.querySelector(`.cw-msg[data-key="${CSS.escape(btn.dataset.key)}"] [data-act="confirm-delete"]`)?.focus();
      } else if (act === 'cancel-delete') {
        review.confirmingDelete = null;
        renderThreads();
      } else if (act === 'confirm-delete') {
        const replyId = btn.dataset.key.split('/')[1] || null;
        btn.disabled = true;
        const { comment } = await api('/delete', { id, body: { reply: replyId } });
        review.confirmingDelete = null;
        if (replyId) replace(comment);
        else review.comments = review.comments.filter((x) => x.id !== id);
        renderThreads();
        toast(replyId ? 'Reply deleted' : c && c.replies.length ? 'Thread deleted' : 'Comment deleted');
      } else if (act === 'copy-link') {
        copy(`${location.origin}${location.pathname}#comment-${id}`, 'Copied link to comment');
      }
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement) || !t.closest('.cw-composer')) return;
    // Edit boxes keep their buttons in the thread's action row; other composers inline.
    const scope = t.closest('.cw-composer.edit') ? t.closest('.cw-thread') : t.closest('.cw-composer');
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      scope.querySelector('[data-act="save-edit"], .cw-btn.primary')?.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      scope.querySelector('[data-act="cancel-edit"], .cw-btn:not(.primary)')?.click();
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement) || !t.closest('.cw-composer')) return;
    autosize(t);
    if (t.closest('.cw-composer-row')) review.drafts.set('new', t.value);
  });

  // -- navigation between open threads (n / p) --
  function openThreads() {
    return $$('.cw-thread').filter((t) => !t.classList.contains('resolved'));
  }

  let threadCursor = -1;
  function jumpToThread(dir) {
    const threads = openThreads();
    if (!threads.length) return toast(review.comments.length ? 'No open comments' : 'No comments yet — select lines and press c');
    const y = window.innerHeight * 0.3;
    if (dir > 0) threadCursor = threads.findIndex((t) => t.getBoundingClientRect().top > y + 4);
    else threadCursor = threads.map((t) => t.getBoundingClientRect().top < y - 4).lastIndexOf(true);
    if (threadCursor === -1) threadCursor = dir > 0 ? 0 : threads.length - 1;
    focusThread(threads[threadCursor].dataset.id);
  }

  function focusThread(id) {
    let node = document.getElementById(`comment-${id}`);
    if (!node) {
      const hit = review.comments.find((c) => c.id.startsWith(id));
      node = hit && document.getElementById(`comment-${hit.id}`);
    }
    if (!node) return toast('That comment isn’t in this walk');
    openFold(node);
    const top = window.scrollY + node.getBoundingClientRect().top - window.innerHeight * 0.3;
    window.scrollTo({ top: Math.max(0, top) });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  loadComments();

  // ---- TOC active section -------------------------------------------------------------
  const tocLinks = $$('.cw-toc a');
  if (tocLinks.length) {
    const byId = new Map(tocLinks.map((a) => [a.dataset.id, a]));
    const hs = $$('.cw-article h2, .cw-article h3').filter((h) => byId.has(h.id));
    const update = () => {
      // Above the first heading, the title link at the top of the sidebar is the active one.
      let active = null;
      for (const h of hs) if (h.getBoundingClientRect().top < window.innerHeight * 0.25) active = h;
      const id = active ? active.id : '';
      tocLinks.forEach((a) => a.classList.toggle('active', a.dataset.id === id));
    };
    tocLinks[0].addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0 });
      history.replaceState(null, '', location.pathname);
    });
    window.addEventListener('scroll', update, { passive: true });
    update();
  }
})();

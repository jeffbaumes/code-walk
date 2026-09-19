import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRef } from '../src/refs.js';
import { resolveRef } from '../src/resolve.js';
import { walkFromSource, loadWalk } from '../src/walk.js';
import { prepareWalk, renderWalkHtml } from '../src/render.js';
import { resolveUrlText } from '../src/commands/resolve.js';
import { outlineCommand } from '../src/commands/outline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let dir;
let repo;
let walk;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'code-walk-test-'));
  execFileSync(process.execPath, [path.join(here, '..', 'scripts', 'demo.js'), dir, '--no-serve'], { stdio: 'pipe' });
  repo = path.join(dir, 'gateway');
  walk = await walkFromSource('', null, { fallbackDir: repo });
});

const resolve = (s, opts) => resolveRef(walk, parseRef(s), { tokens: false, ...opts });

test('show file at a branch with a range', async () => {
  const r = await resolve('show feature/rate-limit:src/limiter.ts L19-24');
  assert.equal(r.kind, 'file');
  const s = r.sections[0];
  assert.equal(s.sides[0].type, 'commit');
  assert.equal(s.sides[0].rev, 'feature/rate-limit');
  assert.deepEqual(s.span, { start: 18, end: 24 });
  assert.match(s.linkTokens.join(' '), /^show [0-9a-f]{12}:src\/limiter\.ts$/);
  assert.equal(s.displayCmd, 'git show feature/rate-limit:src/limiter.ts');
});

test('staged and working tree files', async () => {
  const staged = await resolve('show :src/limiter.ts');
  assert.equal(staged.sections[0].sides[0].type, 'index');
  assert.match(staged.sections[0].newText, /name\?: string/);
  assert.doesNotMatch(staged.sections[0].newText, /console\.warn/);
  const wt = await resolve('show src/limiter.ts');
  assert.equal(wt.sections[0].sides[0].type, 'worktree');
  assert.match(wt.sections[0].newText, /console\.warn/);
});

test('three-dot diff uses the merge base', async () => {
  const r = await resolve('diff main...feature/rate-limit');
  assert.equal(r.sections.length, 3);
  const router = r.sections.find((s) => s.path === 'src/router.ts');
  assert.equal(router.sides[0].mergeBase, true);
  assert.equal(router.added, 6);
  assert.equal(router.removed, 1);
  assert.equal(r.sections.find((s) => s.path === 'src/limiter.ts').status, 'A');
});

test('diff side combinations', async () => {
  const cached = await resolve('diff --cached -- src/limiter.ts');
  assert.deepEqual(cached.sections[0].sides.map((s) => s.type), ['commit', 'index']);
  assert.equal(cached.sections[0].added, 2);
  const unstaged = await resolve('diff -- src/limiter.ts');
  assert.deepEqual(unstaged.sections[0].sides.map((s) => s.type), ['index', 'worktree']);
  const head = await resolve('diff HEAD -- src/limiter.ts');
  assert.deepEqual(head.sections[0].sides.map((s) => s.type), ['commit', 'worktree']);
  assert.equal(head.sections[0].linkTokens.join(' ').split(' ')[1].length, 12);
});

test('commit show', async () => {
  const r = await resolve('show HEAD~1');
  assert.equal(r.kind, 'commit');
  assert.equal(r.commit.subject, 'Add token bucket rate limiter');
  assert.equal(r.sections[0].path, 'src/limiter.ts');
});

test('cross-side selection and errors', async () => {
  const r = await resolve('diff main...feature/rate-limit -- src/router.ts L14-R19');
  const rows = r.sections[0].rows.slice(r.sections[0].span.start, r.sections[0].span.end);
  assert.deepEqual(rows.map((x) => x.t), ['-', '+']);
  await assert.rejects(resolve('show main:src/limiter.ts'), /does not exist/);
  await assert.rejects(resolve('diff main...feature/rate-limit L3'), /exactly one file/);
  await assert.rejects(resolve('diff nope..main'), /unknown revision/);
});

test('word-level marks on modified lines', async () => {
  const r = await resolve('diff main...feature/rate-limit -- src/router.ts');
  const del = r.sections[0].rows.find((x) => x.t === '-');
  assert.ok(del.marks && del.marks.length);
});

test('resolve text from a URL', async () => {
  const text = await resolveUrlText('http://localhost:4747/w/x#diff+main...feature/rate-limit+--+src/router.ts&R14-16', { cwd: repo });
  assert.match(text, /^\$ git diff main\.\.\.feature\/rate-limit -- src\/router\.ts/);
  assert.match(text, />\s+14 \+/);
});

test('outline prints ready-to-paste blocks', async () => {
  const text = await outlineCommand(['-C', repo, 'main...feature/rate-limit']);
  assert.match(text, /diff main\.\.\.feature\/rate-limit -- src\/router\.ts/);
  assert.match(text, /hunk=1 {2}R1-22/);
  assert.match(text, /show [0-9a-f]{7} {4}Add token bucket rate limiter/);
});

test('renders the demo walk without errors', async () => {
  const w = await loadWalk(path.join(dir, 'rate-limit.md'));
  const prepared = await prepareWalk(w);
  assert.deepEqual(prepared.refs.filter((r) => r.error), []);
  const html = renderWalkHtml(prepared, w);
  assert.match(html, /class="cw-side index"/);
  assert.match(html, /class="cw-side worktree"/);
  assert.match(html, /<pre class="mermaid">/);
  assert.match(html, /tr class="r hl"/);
});

test('multi-repo walks use -C names', async () => {
  const other = path.join(dir, 'other');
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  writeFileSync(path.join(other, 'a.txt'), 'one\ntwo\n');
  execFileSync('git', ['-C', other, 'add', '.']);
  execFileSync('git', ['-C', other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const w = await walkFromSource('---\nrepos:\n  gateway: ./gateway\n  other: ./other\n---\n', path.join(dir, 'multi.md'));
  const r = await resolveRef(w, parseRef('show -C other main:a.txt L2'), { tokens: false });
  assert.equal(r.repo.name, 'other');
  assert.equal(r.sections[0].linkTokens[0], '-C');
  assert.equal(r.sections[0].displayCmd, 'git -C ./other show main:a.txt');
  await assert.rejects(resolveRef(w, parseRef('show -C nope HEAD:a'), { tokens: false }), /unknown repo "nope"/);
});

test('review comments: add from the browser API shape, list, reply and resolve from the CLI', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'code-walk-home-'));
  process.env.CODE_WALK_HOME = home;
  const { addComment, loadComments, recordWalk } = await import('../src/comments.js');
  const { commentsCommand } = await import('../src/commands/comments.js');
  const walkPath = path.join(dir, 'rate-limit.md');
  await recordWalk(walkPath, [repo]);
  const c = await addComment(walkPath, {
    author: 'Jeff',
    body: 'Hard-coded retry-after?',
    anchor: {
      link: 'diff 2b88ce2dbf1f..de7efebec33f -- src/router.ts', range: 'R14-16', path: 'src/router.ts', mode: 'diff',
      repo, command: 'diff 2b88ce2dbf1f..de7efebec33f -- src/router.ts', section: 'Wiring it into the router',
      lines: [{ o: null, n: 15, t: '+', text: "    return { status: 429 };" }],
    },
  });
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    const listed = await commentsCommand([]);
    assert.match(listed, new RegExp(`\\[${c.id}\\] src/router\\.ts · R14-16`));
    assert.match(listed, /15 \+ {5}return \{ status: 429 \};/);
    assert.match(listed, /Jeff \(.*\): Hard-coded retry-after\?/);
    assert.match(await commentsCommand(['reply', c.id.slice(0, 4), 'Fixed', 'it', '--resolve']), /resolved it/);
    assert.match(await commentsCommand([]), /No open comments/);
    assert.match(await commentsCommand(["--all"]), /↳ \[[0-9a-f]{6}\] Claude \(.*\): Fixed it/);
  } finally {
    process.chdir(cwd);
    delete process.env.CODE_WALK_HOME;
  }
  const { comments } = await loadComments(walkPath);
  assert.equal(comments[0].status, 'resolved');
});

test('review comments: replies get ids and can be edited or deleted individually', async () => {
  const { addComment, addReply, editComment, deleteComment, loadComments } = await import('../src/comments.js');
  const walkPath = path.join(dir, 'replies.md');
  writeFileSync(walkPath, '# replies\n');
  const c = await addComment(walkPath, { body: 'root', author: 'Jeff' });
  const one = (await addReply(walkPath, c.id, { body: 'one', author: 'Claude' })).replies[0];
  const two = (await addReply(walkPath, c.id, { body: 'two', author: 'Jeff' })).replies[1];
  assert.ok(one.id && two.id && one.id !== two.id);
  await editComment(walkPath, c.id, 'one (edited)', one.id, { base: 'one' });
  await deleteComment(walkPath, c.id, two.id);
  let { comments } = await loadComments(walkPath);
  assert.equal(comments[0].body, 'root');
  assert.deepEqual(comments[0].replies.map((r) => r.body), ['one (edited)']);
  assert.ok(comments[0].replies[0].edited);
  await deleteComment(walkPath, c.id);
  ({ comments } = await loadComments(walkPath));
  assert.equal(comments.length, 0);
});

test('review comments: edits never overwrite text the editor has not seen', async () => {
  const { addComment, editComment, replaceInComment, loadComments, EditConflictError } = await import('../src/comments.js');
  const { commentsCommand } = await import('../src/commands/comments.js');
  const walkPath = path.join(dir, 'conflicts.md');
  writeFileSync(walkPath, '# conflicts\n');
  const c = await addComment(walkPath, { body: 'The limiter leaks memory.', author: 'Claude' });

  // Browser-style save: based on stale text -> refused, current text reported.
  await editComment(walkPath, c.id, 'The limiter leaks memory per client.', null, { base: 'The limiter leaks memory.' });
  await assert.rejects(
    editComment(walkPath, c.id, 'overwrite', null, { base: 'The limiter leaks memory.' }),
    (e) => e instanceof EditConflictError && e.current === 'The limiter leaks memory per client.',
  );
  await assert.rejects(editComment(walkPath, c.id, 'no base'), /based on/);

  // CLI-style replace: --old must match exactly once.
  await replaceInComment(walkPath, c.id, 'The limiter', 'Claude said: The limiter');
  await assert.rejects(replaceInComment(walkPath, c.id, 'not there', 'x'), EditConflictError);
  await assert.rejects(
    commentsCommand(['edit', c.id, '--walk', walkPath, '--old', 'nope', '--new', 'x']),
    /Nothing was changed\. Current text:\n---\nClaude said: The limiter leaks memory per client\./,
  );
  const { comments } = await loadComments(walkPath);
  assert.equal(comments[0].body, 'Claude said: The limiter leaks memory per client.');
});

test('review comments: concurrent writers from separate processes do not lose updates', async () => {
  const walkPath = path.join(dir, 'concurrent.md');
  writeFileSync(walkPath, '# concurrent\n');
  const { addComment, loadComments } = await import('../src/comments.js');
  const c = await addComment(walkPath, { body: 'root', author: 'Jeff' });
  const script = `import { addReply } from ${JSON.stringify(path.join(here, '..', 'src', 'comments.js'))};
    for (let i = 0; i < 15; i++) await addReply(process.argv[1], process.argv[2], { body: process.argv[3] + i });`;
  const { spawn } = await import('node:child_process');
  const run = (tag) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, walkPath, c.id, tag], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}`))));
  });
  await Promise.all([run('a'), run('b'), run('c')]);
  const { comments } = await loadComments(walkPath);
  assert.equal(comments[0].replies.length, 45);
});

test('--stat summaries: totals, grouping, notes, ungrouped files and warnings', async () => {
  const { resolveStat } = await import('../src/stats.js');
  const s = await resolveStat(walk, parseRef('diff --stat main...feature/rate-limit'), `
- group: Backend
  note: Limiter and wiring
  files:
    src/limiter.ts: New token bucket
    src/**: Other source
- group: Tests
  files: [test/**]
`);
  assert.equal(s.commits, 2);
  assert.deepEqual(s.totals, { added: 42, removed: 2, count: 3 });
  assert.deepEqual(s.groups.map((g) => [g.name, g.count, g.added, g.removed]), [
    ['Backend', 2, 41, 1],
    ['Ungrouped', 1, 1, 1],
  ]);
  const backend = s.groups[0].files;
  assert.deepEqual(backend.map((f) => [f.path, f.status, f.note]), [
    ['src/limiter.ts', 'A', 'New token bucket'],
    ['src/router.ts', 'M', 'Other source'],
  ]);
  assert.deepEqual(s.warnings, ['group "Tests": "test/**" matches no changed files']);

  // No body: one ungrouped list. Paths narrow the diff. show --stat summarizes one commit.
  const plain = await resolveStat(walk, parseRef('diff --stat main...feature/rate-limit -- src/'), '');
  assert.equal(plain.grouped, false);
  assert.deepEqual(plain.files.map((f) => f.path), ['src/limiter.ts', 'src/router.ts']);
  const commit = await resolveStat(walk, parseRef('show --stat HEAD~1'), '');
  assert.equal(commit.commit.subject, 'Add token bucket rate limiter');
  assert.equal(commit.commits, null);
  assert.deepEqual(commit.totals, { added: 35, removed: 0, count: 1 });

  // Staged changes have no commit count but still summarize.
  const staged = await resolveStat(walk, parseRef('diff --stat --cached'), '');
  assert.deepEqual(staged.files.map((f) => [f.path, f.added]), [['src/limiter.ts', 2]]);
});

test('--stat summaries render and check reports their warnings', async () => {
  const walkPath = path.join(dir, 'summary.md');
  writeFileSync(walkPath, [
    '---', 'repos:', '  gateway: ./gateway', '---', '# Summary',
    '```diff --stat main...feature/rate-limit', '- group: Backend', '  files: [src/]', '- group: Tests', '  files: test/', '```',
    '```show --stat HEAD~1', '```',
    '```diff main...feature/rate-limit -- src/router.ts', '```', '',
  ].join('\n'));
  const w = await loadWalk(walkPath);
  const prepared = await prepareWalk(w);
  assert.deepEqual(prepared.refs.filter((r) => r.error), []);
  const html = renderWalkHtml(prepared, w);
  assert.equal((html.match(/class="cw-summary"/g) || []).length, 2);
  assert.match(html, /<span class="cw-sum-groupname">Backend<\/span>/);
  assert.match(html, /<span class="cw-sum-groupname">Ungrouped<\/span>/);
  assert.match(html, /cw-sum-total/);
  assert.match(html, /git diff --stat main\.\.\.feature\/rate-limit/);

  const { checkCommand } = await import('../src/commands/check.js');
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    assert.equal(await checkCommand([walkPath]), 0);
  } finally {
    console.log = log;
  }
  assert.match(lines.join('\n'), /summary\.md:6: warning: group "Tests": "test\/" matches no changed files/);
});

test('viewing hint: not rendered, and check warns when it is missing', async () => {
  const hint = '> 📖 **Code Walk** — view it with `code-walk serve hint.md` ([code-walk](https://github.com/jeffbaumes/code-walk)).\n';
  const withHint = path.join(dir, 'hint.md');
  const without = path.join(dir, 'nohint.md');
  writeFileSync(withHint, `---\nrepos:\n  gateway: ./gateway\n---\n\n${hint}\n# Hinted\n\n> An ordinary quote.\n`);
  writeFileSync(without, '---\nrepos:\n  gateway: ./gateway\n---\n\n# Plain\n');
  const w = await loadWalk(withHint);
  const prepared = await prepareWalk(w);
  assert.equal(prepared.hasHint, true);
  const html = renderWalkHtml(prepared, w);
  assert.doesNotMatch(html, /Code Walk/);
  assert.match(html, /An ordinary quote/);
  assert.equal((await prepareWalk(await loadWalk(without))).hasHint, false);

  const { checkCommand } = await import('../src/commands/check.js');
  const run = async (file) => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { await checkCommand([file]); } finally { console.log = log; }
    return lines.join('\n');
  };
  assert.match(await run(without), /nohint\.md: warning: no viewing hint/);
  assert.doesNotMatch(await run(withHint), /viewing hint/);
});

test('page: folds toggle both ways, and the sidebar starts with a link to the top', async () => {
  const { pageHtml } = await import('../src/render.js');
  const w = await loadWalk(path.join(dir, 'hint.md'));
  const walkFile = path.join(dir, 'folds.md');
  writeFileSync(walkFile, '---\nrepos:\n  gateway: ./gateway\n---\n# Folds\n\n## One\n\n```show main:src/router.ts L1-2\n```\n\n### Two\n');
  const fw = await loadWalk(walkFile);
  const prepared = await prepareWalk(fw);
  const content = renderWalkHtml(prepared, fw);
  assert.match(content, /class="cw-more"/);
  assert.match(content, /class="cw-less">.*Hide \d+ lines/);
  const page = pageHtml({ title: prepared.title, toc: prepared.toc, content, walk: fw, walkName: 'folds', hasMermaid: false });
  const links = [...page.matchAll(/<nav class="cw-toc"[\s\S]*?<\/nav>/g)][0][0].match(/<a [^>]*>[^<]*<\/a>/g);
  assert.match(links[0], /class="l1 home" href="#"[^>]*>Folds</);
  assert.equal(links.length, 3);
  assert.ok(w);
});

test('remote repos: a URL is cloned into the cache and read like a local repo', async () => {
  const cache = mkdtempSync(path.join(os.tmpdir(), 'code-walk-cache-'));
  process.env.CODE_WALK_HOME = cache;
  try {
    const url = `file://${repo}`;
    const walkFile = path.join(dir, 'remote.md');
    writeFileSync(walkFile, `---\nrepo: ${url}\n---\n# Remote\n\n\`\`\`show feature/rate-limit:src/limiter.ts L19-24\n\`\`\`\n\n\`\`\`diff main...feature/rate-limit -- src/router.ts\n\`\`\`\n\n\`\`\`show src/limiter.ts\n\`\`\`\n`);
    const w = await loadWalk(walkFile);
    assert.equal(w.repos[0].name, 'gateway');
    assert.equal(w.repos[0].remote, url);
    const prepared = await prepareWalk(w, { highlight: false });
    const [file, diff, worktree] = prepared.refs;
    assert.equal(file.error, undefined);
    assert.equal(file.result.sections[0].sides[0].rev, 'feature/rate-limit');
    assert.equal(diff.error, undefined);
    assert.equal(diff.result.sections[0].added, 6);
    assert.match(file.result.repo.root, /repos[\\/]gateway-[0-9a-f]{12}$/);
    assert.match(file.result.sections[0].displayCmd, /^git -C .*repos\/gateway-[0-9a-f]{12} show feature\/rate-limit:src\/limiter\.ts$/);
    // Working-tree and staged content only exist locally.
    assert.match(worktree.error, /isn't available in a remote repo/);

    // An unreachable URL fails with a clear message, and ad hoc `-C <url>` works too.
    const bad = await walkFromSource('', null, { fallbackDir: repo });
    await assert.rejects(resolveRef(bad, parseRef('show -C file:///nonexistent/nope.git main:x'), { tokens: false }), /could not clone/);
    const adhoc = await resolveRef(bad, parseRef(`show -C ${url} main:src/router.ts L1-2`), { tokens: false });
    assert.equal(adhoc.repo.remote, url);
  } finally {
    delete process.env.CODE_WALK_HOME;
  }
});

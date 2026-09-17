import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRef, parseSelection, formatSelection, encodeFragment, decodeFragment, RefError } from '../src/refs.js';
import { diffRows, groupHunks, selectionSpan } from '../src/rows.js';

test('parses show forms', () => {
  assert.deepEqual(parseRef('show main:src/x.ts L20-24'), {
    command: 'show', repo: null, cached: false, stat: false, revs: [], target: 'main:src/x.ts', paths: [],
    selection: { type: 'range', start: { side: 'L', line: 20 }, end: { side: 'L', line: 24 } },
  });
  assert.equal(parseRef('show :src/x.ts').target, ':src/x.ts');
  assert.deepEqual(parseRef('show a1b2c3d -- src/x.ts').paths, ['src/x.ts']);
  assert.equal(parseRef('-C sdk show HEAD:a').repo, 'sdk');
  assert.equal(parseRef('show -C sdk HEAD:a').repo, 'sdk');
});

test('parses diff forms', () => {
  const r = parseRef('diff --cached a1b2c3d -- src/x.ts R30-35');
  assert.equal(r.cached, true);
  assert.deepEqual(r.revs, ['a1b2c3d']);
  assert.deepEqual(r.selection.start, { side: 'R', line: 30 });
  assert.deepEqual(parseRef('diff main...feature').revs, ['main...feature']);
  assert.deepEqual(parseRef('diff -- a b').paths, ['a', 'b']);
  assert.deepEqual(parseRef('diff main...feature -- x hunk=2').selection, { type: 'hunk', n: 2 });
});

test('rejects bad input', () => {
  assert.throws(() => parseRef('log main'), RefError);
  assert.throws(() => parseRef('diff --name-only main'), /unsupported option/);
  assert.throws(() => parseRef('diff a..b c'), RefError);
  assert.throws(() => parseRef('diff --cached a..b'), RefError);
  assert.throws(() => parseRef('show a b'), RefError);
  assert.throws(() => parseSelection('R14-L12'), RefError);
  assert.throws(() => parseSelection('L20-10'), RefError);
});

test('selection round-trips', () => {
  for (const s of ['L20', 'L20-24', 'R3-9', 'L12-R14', 'hunk=3']) assert.equal(formatSelection(parseSelection(s)), s);
});

test('fragments round-trip and stay readable', () => {
  const tokens = ['-C', 'sdk', 'diff', '--cached', 'a1b2c3d', '--', 'src/my file+x.ts'];
  const frag = encodeFragment(tokens, parseSelection('L12-R14'));
  assert.equal(frag, '-C+sdk+diff+--cached+a1b2c3d+--+src/my%20file%2Bx.ts&L12-R14');
  const back = decodeFragment(`http://localhost:4747/w/x#${frag}`);
  assert.deepEqual(back.tokens, tokens);
  assert.equal(formatSelection(back.selection), 'L12-R14');
});

test('diff rows, hunks and selections', () => {
  const oldLines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'];
  const newLines = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'];
  const rows = diffRows(oldLines, newLines, [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
    { oldStart: 15, oldCount: 0, newStart: 15, newCount: 1 },
  ]);
  assert.equal(rows.length, 16);
  const hunks = groupHunks(rows);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], { start: 0, end: 6 });
  const mode = { mode: 'diff', hunks };
  assert.deepEqual(selectionSpan(rows, parseSelection('L2-R2'), mode), { start: 1, end: 3 });
  assert.deepEqual(selectionSpan(rows, parseSelection('R15'), mode), { start: 15, end: 16 });
  assert.deepEqual(selectionSpan(rows, parseSelection('hunk=2'), mode), hunks[1]);
  assert.throws(() => selectionSpan(rows, parseSelection('R40'), mode), /out of range/);
  assert.throws(() => selectionSpan(rows, parseSelection('hunk=3'), mode), /does not exist/);
});

test('--stat parses for diff and show, and rejects line selections', async () => {
  const d = parseRef('diff -C sdk --stat main...feature -- src/');
  assert.equal(d.stat, true);
  assert.equal(d.repo, 'sdk');
  assert.deepEqual(d.revs, ['main...feature']);
  assert.equal(parseRef('show --stat a1b2c3d').stat, true);
  assert.throws(() => parseRef('diff --stat main...feature -- x R1-3'), /line selection/);
  assert.throws(() => parseRef('show --stat main:src/x.ts'), /takes a commit/);
});

test('summary globs and group definitions', async () => {
  const { globToRegExp, parseGroups } = await import('../src/stats.js');
  const m = (g, p) => globToRegExp(g).test(p);
  assert.ok(m('src/**', 'src/a/b.ts'));
  assert.ok(m('src/', 'src/a/b.ts'));
  assert.ok(m('**/*.test.ts', 'a.test.ts'));
  assert.ok(m('**/*.test.ts', 'src/deep/a.test.ts'));
  assert.ok(!m('src/*.ts', 'src/a/b.ts'));
  assert.ok(m('README.md', 'README.md'));
  assert.ok(!m('README.md', 'docs/README.md'));

  const groups = parseGroups('- group: Backend\n  note: Server side\n  files:\n    src/**: Server code\n- group: Docs\n  files: [README.md]\n- group: Misc\n  files: "*.json"');
  assert.deepEqual(groups.map((g) => [g.name, g.note, g.patterns.map((p) => [p.pattern, p.note])]), [
    ['Backend', 'Server side', [['src/**', 'Server code']]],
    ['Docs', null, [['README.md', null]]],
    ['Misc', null, [['*.json', null]]],
  ]);
  assert.deepEqual(parseGroups(''), []);
  assert.throws(() => parseGroups('group: x'), /YAML list/);
  assert.throws(() => parseGroups('- files: [a]'), /needs a name/);
  assert.throws(() => parseGroups('- group: A'), /needs "files"/);
  assert.throws(() => parseGroups('- group: A\n  files: [a]\n  colour: red'), /unknown key "colour"/);
  assert.throws(() => parseGroups('- group: Ungrouped\n  files: [a]'), /reserved/);
});

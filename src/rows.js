// Row model for snippets. A row is one displayed line:
//   { t: ' ' | '-' | '+', o: oldLine|null, n: newLine|null, marks?: [[start,end],...] }
// File snippets use only `n` (their single line number) with t = ' '.
import { diffWordsWithSpace } from 'diff';
import { RefError } from './refs.js';

export const CONTEXT = 3;

export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export function fileRows(lineCount) {
  const rows = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) rows[i] = { t: ' ', o: null, n: i + 1 };
  return rows;
}

/** Build full-file unified rows from both line arrays and exact change regions. */
export function diffRows(oldLines, newLines, regions) {
  const rows = [];
  let o = 1;
  let n = 1;
  for (const r of regions) {
    while (o < r.oldStart && n < r.newStart) rows.push({ t: ' ', o: o++, n: n++ });
    for (let i = 0; i < r.oldCount; i++) rows.push({ t: '-', o: o++, n: null });
    for (let i = 0; i < r.newCount; i++) rows.push({ t: '+', o: null, n: n++ });
  }
  while (o <= oldLines.length && n <= newLines.length) rows.push({ t: ' ', o: o++, n: n++ });
  // Guard against inconsistent inputs (e.g. a missing trailing newline difference).
  while (o <= oldLines.length) rows.push({ t: '-', o: o++, n: null });
  while (n <= newLines.length) rows.push({ t: '+', o: null, n: n++ });
  addWordMarks(rows, oldLines, newLines);
  return rows;
}

/** Hunks as git prints them with -U3: [{start, end}] row index ranges, end exclusive. */
export function groupHunks(rows, context = CONTEXT) {
  const hunks = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t === ' ') { i++; continue; }
    let start = Math.max(0, i - context);
    let j = i;
    while (j < rows.length && rows[j].t !== ' ') j++;
    let end = Math.min(rows.length, j + context);
    const prev = hunks[hunks.length - 1];
    if (prev && start <= prev.end) {
      prev.end = end;
    } else {
      hunks.push({ start, end });
    }
    i = j;
  }
  return hunks;
}

export function hunkSummary(rows, h) {
  const olds = [];
  const news = [];
  let added = 0;
  let removed = 0;
  for (let i = h.start; i < h.end; i++) {
    const r = rows[i];
    if (r.o) olds.push(r.o);
    if (r.n) news.push(r.n);
    if (r.t === '+') added++;
    if (r.t === '-') removed++;
  }
  const span = (a) => (a.length ? (a[0] === a[a.length - 1] ? `${a[0]}` : `${a[0]}-${a[a.length - 1]}`) : null);
  return { old: span(olds), new: span(news), added, removed };
}

function lineOn(row, side) {
  return side === 'L' ? row.o : row.n;
}

/**
 * Row index span [start, end) for a selection, or throws RefError.
 * For file snippets only L ranges are valid (rows carry the line in `n`).
 */
export function selectionSpan(rows, sel, { mode, hunks }) {
  if (sel.type === 'hunk') {
    if (mode !== 'diff') throw new RefError('hunk=N only applies to diffs');
    const h = hunks[sel.n - 1];
    if (!h) throw new RefError(`hunk=${sel.n} does not exist (the diff has ${hunks.length} hunk${hunks.length === 1 ? '' : 's'})`);
    return { start: h.start, end: h.end };
  }
  const { start: s, end: e } = sel;
  const get = mode === 'diff' ? lineOn : (row) => row.n;
  if (mode !== 'diff' && (s.side === 'R' || e.side === 'R')) {
    throw new RefError('file snippets use L ranges (e.g. L20-24); R is the new side of a diff');
  }
  let startIdx = -1;
  let endIdx = -1;
  if (s.side === e.side) {
    for (let i = 0; i < rows.length; i++) {
      const ln = get(rows[i], s.side);
      if (ln !== null && ln >= s.line && ln <= e.line) {
        if (startIdx === -1) startIdx = i;
        endIdx = i;
      }
    }
    if (startIdx === -1) {
      const max = rows.reduce((m, r) => Math.max(m, get(r, s.side) || 0), 0);
      throw new RefError(`lines ${s.side}${s.line}-${e.line} are out of range (${mode === 'diff' ? (s.side === 'L' ? 'old side' : 'new side') : 'file'} has ${max} lines)`);
    }
  } else {
    startIdx = rows.findIndex((r) => lineOn(r, s.side) === s.line);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (lineOn(rows[i], e.side) === e.line) { endIdx = i; break; }
    }
    if (startIdx === -1) throw new RefError(`line ${s.side}${s.line} is out of range`);
    if (endIdx === -1) throw new RefError(`line ${e.side}${e.line} is out of range`);
    if (endIdx < startIdx) throw new RefError(`${s.side}${s.line} comes after ${e.side}${e.line} in the diff`);
  }
  return { start: startIdx, end: endIdx + 1 };
}

/** Does a row match a `highlight:` spec entry ({side, from, to})? */
export function rowMatches(row, spec, mode) {
  const ln = mode === 'diff' ? lineOn(row, spec.side) : row.n;
  return ln !== null && ln >= spec.from && ln <= spec.to;
}

export function parseHighlight(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^([LR])?(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) throw new RefError(`bad highlight "${part}" (use e.g. 22-24, R22, L12-13)`);
      return { side: m[1] || 'R', from: Number(m[2]), to: Number(m[3] ?? m[2]) };
    });
}

// ---- word-level emphasis ---------------------------------------------------

function addWordMarks(rows, oldLines, newLines) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t !== '-') { i++; continue; }
    const dels = [];
    while (i < rows.length && rows[i].t === '-') dels.push(rows[i++]);
    const adds = [];
    while (i < rows.length && rows[i].t === '+') adds.push(rows[i++]);
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      markPair(dels[k], adds[k], oldLines[dels[k].o - 1] ?? '', newLines[adds[k].n - 1] ?? '');
    }
  }
}

function markPair(delRow, addRow, a, b) {
  if (a === b || a.length + b.length > 2000) return;
  const parts = diffWordsWithSpace(a, b);
  const oldMarks = [];
  const newMarks = [];
  let oi = 0;
  let ni = 0;
  let same = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.added) { newMarks.push([ni, ni + len]); ni += len; }
    else if (p.removed) { oldMarks.push([oi, oi + len]); oi += len; }
    else { same += len; oi += len; ni += len; }
  }
  // Only emphasize when the lines are mostly similar; otherwise it's noise.
  const nonWs = (s) => s.replace(/\s/g, '').length;
  if (same < 0.4 * Math.max(a.length, b.length) || nonWs(a) === 0 || nonWs(b) === 0) return;
  if (oldMarks.length) delRow.marks = oldMarks;
  if (newMarks.length) addRow.marks = newMarks;
}

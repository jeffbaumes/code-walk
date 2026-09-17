// Parsing of reference strings: fenced-block info strings (`diff main...feature -- src/x.ts R30-35`)
// and URL fragments (`diff+main...feature+--+src/x.ts&R30-35`). Pure syntax; no git access.

export class RefError extends Error {}

export const SELECTION_RE = /^(?:([LR])(\d+)(?:-([LR])?(\d+))?|hunk=(\d+))$/;

export function tokenize(str) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\(.)/g, '$1'));
    else if (m[2] !== undefined) tokens.push(m[2]);
    else tokens.push(m[3]);
  }
  return tokens;
}

export function parseSelection(token) {
  const m = SELECTION_RE.exec(token);
  if (!m) return null;
  if (m[5] !== undefined) {
    const n = Number(m[5]);
    if (n < 1) throw new RefError(`hunk numbers start at 1: ${token}`);
    return { type: 'hunk', n };
  }
  const start = { side: m[1], line: Number(m[2]) };
  const end = m[4] !== undefined ? { side: m[3] || m[1], line: Number(m[4]) } : { ...start };
  if (start.line < 1 || end.line < 1) throw new RefError(`line numbers start at 1: ${token}`);
  if (start.side === end.side && end.line < start.line) {
    throw new RefError(`range end is before its start: ${token}`);
  }
  if (start.side === 'R' && end.side === 'L') {
    throw new RefError(`a cross-side range goes from L (old) to R (new), e.g. L12-R14: ${token}`);
  }
  return { type: 'range', start, end };
}

export function formatSelection(sel) {
  if (!sel) return '';
  if (sel.type === 'hunk') return `hunk=${sel.n}`;
  const { start, end } = sel;
  if (start.side === end.side) {
    return start.line === end.line ? `${start.side}${start.line}` : `${start.side}${start.line}-${end.line}`;
  }
  return `${start.side}${start.line}-${end.side}${end.line}`;
}

/**
 * Parse reference arguments into a syntactic description.
 *   { command: 'show'|'diff', repo, cached, revs, target, paths, selection }
 * `target` is the single non-path argument of `show`.
 */
export function parseRef(input) {
  const tokens = Array.isArray(input) ? [...input] : tokenize(input);
  let repo = null;
  const takeRepo = () => {
    if (tokens[0] === '-C') {
      if (tokens.length < 2) throw new RefError('-C needs a repo name or path');
      if (repo !== null) throw new RefError('-C given twice');
      repo = tokens[1];
      tokens.splice(0, 2);
    }
  };
  takeRepo();
  const command = tokens.shift();
  if (command !== 'show' && command !== 'diff') {
    throw new RefError(`expected "show" or "diff", got ${command === undefined ? 'nothing' : `"${command}"`}`);
  }
  takeRepo();

  let selection = null;
  if (tokens.length && SELECTION_RE.test(tokens[tokens.length - 1])) {
    selection = parseSelection(tokens.pop());
  }

  const dd = tokens.indexOf('--');
  const before = dd === -1 ? tokens : tokens.slice(0, dd);
  const paths = dd === -1 ? [] : tokens.slice(dd + 1);
  if (dd !== -1 && paths.length === 0) throw new RefError('"--" must be followed by at least one path');

  const ref = { command, repo, cached: false, stat: false, revs: [], target: null, paths, selection };

  for (const tok of before) {
    if (command === 'diff' && (tok === '--cached' || tok === '--staged')) {
      ref.cached = true;
    } else if (tok === '--stat') {
      ref.stat = true;
    } else if (tok.startsWith('-')) {
      throw new RefError(`unsupported option "${tok}" (supported: -C <repo>, --stat${command === 'diff' ? ', --cached' : ''})`);
    } else if (command === 'diff') {
      ref.revs.push(tok);
    } else if (ref.target === null) {
      ref.target = tok;
    } else {
      throw new RefError(`show takes one argument (a commit, rev:path, :path or path), got "${ref.target}" and "${tok}"`);
    }
  }

  if (command === 'show' && ref.target === null) {
    throw new RefError('show needs an argument: <commit>, <rev>:<path>, :<path> (staged) or <path> (working tree)');
  }
  if (command === 'diff') {
    if (ref.revs.length > 2) throw new RefError('diff takes at most two revisions');
    if (ref.revs.length === 2 && ref.revs.some((r) => r.includes('..'))) {
      throw new RefError('use either "A..B" or "A B", not both');
    }
    if (ref.cached && (ref.revs.length > 1 || ref.revs.some((r) => r.includes('..')))) {
      throw new RefError('--cached takes at most one revision (compares it to the staged index)');
    }
  }
  if (ref.stat) {
    if (selection) throw new RefError('--stat summarizes whole files; remove the line selection');
    if (command === 'show' && ref.target.includes(':')) throw new RefError('show --stat takes a commit, not <rev>:<path>');
  }
  for (const p of paths) {
    if (p.startsWith('-')) throw new RefError(`paths may not start with "-": ${p}`);
  }
  return ref;
}

export function formatRef(ref) {
  const parts = [];
  if (ref.repo) parts.push('-C', ref.repo);
  parts.push(ref.command);
  if (ref.stat) parts.push('--stat');
  if (ref.cached) parts.push('--cached');
  parts.push(...ref.revs);
  if (ref.target) parts.push(ref.target);
  if (ref.paths.length) parts.push('--', ...ref.paths);
  return parts.map(quoteToken).join(' ');
}

function quoteToken(t) {
  return /[\s"']/.test(t) ? `"${t.replace(/["\\]/g, '\\$&')}"` : t;
}

// ---- URL fragments --------------------------------------------------------

const FRAGMENT_SAFE = /[A-Za-z0-9_\-.~/:^@!,=]/;

function encodeToken(t) {
  let out = '';
  for (const ch of t) {
    out += FRAGMENT_SAFE.test(ch) ? ch : encodeURIComponent(ch).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  return out;
}

/** `["diff","a..b","--","x.ts"]`, selection → `diff+a..b+--+x.ts&R3-5` */
export function encodeFragment(tokens, selection) {
  const s = tokens.map(encodeToken).join('+');
  return selection ? `${s}&${formatSelection(selection)}` : s;
}

/** Inverse of encodeFragment. Accepts a full URL or just the fragment. */
export function decodeFragment(input) {
  let frag = input;
  const hash = input.indexOf('#');
  if (hash !== -1) frag = input.slice(hash + 1);
  let selection = null;
  const amp = frag.lastIndexOf('&');
  if (amp !== -1 && SELECTION_RE.test(frag.slice(amp + 1))) {
    selection = parseSelection(frag.slice(amp + 1));
    frag = frag.slice(0, amp);
  }
  const tokens = frag.split('+').filter(Boolean).map((t) => decodeURIComponent(t));
  return { tokens, selection };
}

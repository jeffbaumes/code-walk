// `code-walk outline [-C <repo>] [diff args]`: a scaffold of changed files and hunks
// printed in walk syntax, so references can be copied instead of guessed.
import { parseRef, formatRef, RefError } from '../refs.js';
import { resolveRef } from '../resolve.js';
import { walkFromSource } from '../walk.js';
import { hunkSummary, splitLines } from '../rows.js';
import { commitsBetween, defaultBase, repoRoot } from '../git.js';

export async function outlineCommand(args) {
  let repoDir = process.cwd();
  const rest = [...args];
  if (rest[0] === '-C') {
    if (!rest[1]) throw new RefError('-C needs a path');
    repoDir = rest[1];
    rest.splice(0, 2);
  }
  const root = await repoRoot(repoDir);
  if (!root) throw new Error(`not a git repository: ${repoDir}`);

  if (!rest.length) {
    const base = await defaultBase(root);
    if (!base) throw new Error('could not find a default base branch; pass a range, e.g. `code-walk outline main...HEAD`');
    rest.unshift(`${base}...HEAD`);
  }

  const ref = parseRef(['diff', ...rest]);
  const walk = await walkFromSource('', null, { fallbackDir: root });
  const result = await resolveRef(walk, ref, { tokens: false });
  const blockBase = formatRef({ ...ref, paths: [] });
  const out = [];
  const [oldSide, newSide] = result.sections[0].sides;

  out.push(`# Outline: git diff ${rest.join(' ')}`);
  out.push(`repo: ${root}${repoDir !== process.cwd() ? `  (use -C <name> in multi-repo walks)` : ''}`);
  out.push(`old (L): ${sideText(oldSide)}`);
  out.push(`new (R): ${sideText(newSide)}`);

  if (oldSide.type === 'commit' && newSide.type === 'commit') {
    const commits = await commitsBetween(root, oldSide.sha, newSide.sha);
    if (commits.length) {
      out.push('', `## Commits (${commits.length}, oldest first)`);
      for (const c of commits) out.push(`  show ${c.sha.slice(0, 7)}    ${c.subject}`);
    }
  }

  let added = 0;
  let removed = 0;
  for (const s of result.sections) { added += s.added; removed += s.removed; }
  out.push('', `## Files (${result.sections.length} changed, +${added} −${removed})`);

  for (const s of result.sections) {
    const paths = s.oldPath && s.newPath && s.oldPath !== s.newPath ? [s.oldPath, s.newPath] : [s.path];
    const status = { A: 'added', D: 'deleted', R: `renamed from ${s.oldPath}`, C: `copied from ${s.oldPath}`, M: 'modified', T: 'type changed' }[s.status] || s.status;
    out.push('', `${s.path}  (${status}${s.binary ? ', binary' : `, +${s.added} −${s.removed}`})`);
    out.push(`  ${blockBase} -- ${paths.join(' ')}`);
    if (s.binary) continue;
    const oldLines = splitLines(s.oldText);
    const newLines = splitLines(s.newText);
    s.hunks.forEach((h, i) => {
      const sum = hunkSummary(s.rows, h);
      const first = s.rows.slice(h.start, h.end).find((r) => r.t !== ' ');
      const text = first ? (first.t === '-' ? oldLines[first.o - 1] : newLines[first.n - 1]) || '' : '';
      const preview = text.trim().slice(0, 70);
      const ranges = [sum.new && `R${sum.new}`, sum.old && `L${sum.old}`].filter(Boolean).join(' ');
      out.push(`    hunk=${i + 1}  ${ranges}  +${sum.added} −${sum.removed}  ${first?.t === '-' ? '−' : '+'} ${preview}`);
    });
  }
  return out.join('\n') + '\n';
}

function sideText(side) {
  if (side.type === 'index') return 'staged index';
  if (side.type === 'worktree') return 'working tree';
  const subject = side.info?.subject ? `  "${side.info.subject}"` : '';
  return `${side.sha.slice(0, 7)} ${side.rev}${subject}`;
}

// `code-walk check <walk.md...>`: verify every reference resolves.
import path from 'node:path';
import { loadWalk } from '../walk.js';
import { prepareWalk } from '../render.js';

export async function checkCommand(files) {
  let failed = 0;
  for (const file of files) {
    const abs = path.resolve(file);
    const rel = path.relative(process.cwd(), abs).startsWith('..') ? abs : path.relative(process.cwd(), abs);
    let prepared;
    try {
      const walk = await loadWalk(file);
      prepared = await prepareWalk(walk, { highlight: false });
    } catch (e) {
      console.log(`${rel}: error: ${e.message}`);
      failed++;
      continue;
    }
    const errors = prepared.refs.filter((r) => r.error);
    for (const r of errors) {
      console.log(`${rel}:${r.line}: error: ${r.error}\n    \`\`\`${r.info}`);
    }
    for (const r of prepared.refs.filter((x) => !x.error && x.warnings?.length)) {
      for (const w of r.warnings) console.log(`${rel}:${r.line}: warning: ${w}\n    \`\`\`${r.info}`);
    }
    if (!prepared.hasHint) {
      console.log(`${rel}: warning: no viewing hint at the top. Add a "> 📖 Code Walk …" quote so people reading the raw .md know how to view it (see the code-walk skill)`);
    }
    failed += errors.length;
    const ok = prepared.refs.length - errors.length;
    console.log(`${errors.length ? '✗' : '✓'} ${rel}: ${ok}/${prepared.refs.length} references resolve`);
  }
  return failed ? 1 : 0;
}

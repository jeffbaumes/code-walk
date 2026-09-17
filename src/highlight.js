// Syntax highlighting with Shiki. Produces per-line token arrays with dual-theme colors.
import { createHighlighter, bundledLanguages } from 'shiki';
import path from 'node:path';

const THEMES = { light: 'github-light', dark: 'github-dark' };
const MAX_BYTES = 400 * 1024;
const MAX_LINES = 10000;

const EXT_ALIASES = {
  h: 'c', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', cc: 'cpp', cxx: 'cpp', mts: 'ts', cts: 'ts', cjs: 'js',
  yml: 'yaml', htm: 'html', svg: 'xml', plist: 'xml', gradle: 'groovy', kts: 'kotlin', txt: 'text',
  bash: 'bash', zsh: 'bash', env: 'dotenv', lock: 'text', conf: 'ini', cfg: 'ini',
};
const NAME_ALIASES = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', cmakelists: 'cmake',
  'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby', justfile: 'just', '.gitignore': 'text',
  '.bashrc': 'bash', '.zshrc': 'bash',
};

let highlighterPromise;
function highlighter() {
  highlighterPromise ??= createHighlighter({ themes: Object.values(THEMES), langs: [] });
  return highlighterPromise;
}

export function langForPath(file) {
  if (!file) return 'text';
  const base = path.basename(file).toLowerCase();
  if (NAME_ALIASES[base]) return NAME_ALIASES[base];
  if (base.startsWith('dockerfile')) return 'dockerfile';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  const lang = EXT_ALIASES[ext] || ext;
  return lang in bundledLanguages ? lang : 'text';
}

export function langForFence(info) {
  const lang = (info || '').trim().split(/\s+/)[0].toLowerCase();
  if (!lang) return 'text';
  return lang in bundledLanguages ? lang : EXT_ALIASES[lang] in bundledLanguages ? EXT_ALIASES[lang] : 'text';
}

const cache = new Map();

/**
 * Highlight text; returns an array of lines, each an array of { content, style } tokens.
 * `style` is a CSS string with the light color and a --shiki-dark variable.
 */
export async function highlightLines(text, lang) {
  const key = `${lang}\x00${text}`;
  if (cache.has(key)) return cache.get(key);
  let result;
  const lineCount = text.split('\n').length;
  if (lang === 'text' || text.length > MAX_BYTES || lineCount > MAX_LINES) {
    result = plain(text);
  } else {
    try {
      const h = await highlighter();
      if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
      const { tokens } = h.codeToTokens(text.replace(/\r\n/g, '\n'), { lang, themes: THEMES });
      result = tokens.map((line) =>
        line.map((t) => ({ content: t.content, style: styleString(t.htmlStyle) })),
      );
    } catch {
      result = plain(text);
    }
  }
  cache.set(key, result);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return result;
}

function plain(text) {
  return text.replace(/\r\n/g, '\n').split('\n').map((l) => [{ content: l, style: '' }]);
}

function styleString(htmlStyle) {
  if (!htmlStyle) return '';
  if (typeof htmlStyle === 'string') return htmlStyle;
  return Object.entries(htmlStyle).map(([k, v]) => `${k}:${v}`).join(';');
}

// SPDX-License-Identifier: Apache-2.0
// Lightweight offline syntax highlighter + diff renderer.
// No external deps (must work in the desktop app with no network).
// Regex tokenizer for common languages; line-diff via LCS.

export type TokenType =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'punct'
  | 'fn'
  | 'plain';

export interface Token {
  t: TokenType;
  v: string;
}

const JS_KEYWORDS =
  'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|in|of|try|catch|finally|throw|class|extends|super|this|import|export|from|default|async|await|yield|static|get|set|true|false|null|undefined|void|interface|type|enum|implements|readonly|keyof|satisfies';
const PY_KEYWORDS =
  'def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|yield|async|await|global|nonlocal|del|assert';
const SH_KEYWORDS =
  'if|then|else|elif|fi|for|while|do|done|case|esac|function|in|export|local|return|exit|set|source|select|until|time|coproc';

interface LangSpec {
  lineComment?: string[];
  blockComment?: [string, string][];
  strings: string[];
  keywords: string;
  numbers?: boolean;
}

const SPECS: Record<string, LangSpec> = {
  js: {
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    strings: ['"', "'", '`'],
    keywords: JS_KEYWORDS,
    numbers: true,
  },
  py: {
    lineComment: ['#'],
    strings: ['"""', "'''", '"', "'"],
    keywords: PY_KEYWORDS,
    numbers: true,
  },
  json: {
    strings: ['"'],
    keywords: 'true|false|null',
    numbers: true,
  },
  sh: {
    lineComment: ['#'],
    strings: ['"', "'"],
    keywords: SH_KEYWORDS,
    numbers: true,
  },
  css: {
    blockComment: [['/*', '*/']],
    strings: ['"', "'"],
    keywords: '@(?:media|import|keyframes|font-face|supports|charset|namespace|page)',
    numbers: true,
  },
  html: {
    blockComment: [['<!--', '-->']],
    strings: ['"', "'"],
    keywords: '',
    numbers: false,
  },
  md: {
    strings: [],
    keywords: '',
    numbers: false,
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tokenize source code. Returns a flat token list; the renderer maps
 * TokenType -> CSS class (tk-kw, tk-str, tk-com, tk-num, tk-punct, tk-fn).
 */
export function tokenize(code: string, lang: string): Token[] {
  const spec = SPECS[lang];
  if (!spec) return [{ t: 'plain', v: code }];

  if (lang === 'md') return tokenizeMarkdown(code);
  if (lang === 'html') return tokenizeHtml(code);

  const tokens: Token[] = [];
  const commentStarts = [
    ...(spec.lineComment ?? []).map((c) => ({ c, block: false as const, end: '' })),
    ...(spec.blockComment ?? []).map(([c, end]) => ({ c, block: true as const, end })),
  ].sort((a, b) => b.c.length - a.c.length);

  const stringStarts = [...spec.strings].sort((a, b) => b.length - a.length);
  const kwRe = spec.keywords ? new RegExp(`^(?:${spec.keywords})\\b`) : null;
  const numRe = spec.numbers ? /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/ : null;
  const fnRe = /^([A-Za-z_$][\w$]*)(?=\s*\()/;

  let i = 0;
  const n = code.length;
  let plain = '';
  const flush = () => {
    if (plain) {
      tokens.push({ t: 'plain', v: plain });
      plain = '';
    }
  };

  while (i < n) {
    // comment
    let matched = false;
    for (const cs of commentStarts) {
      if (code.startsWith(cs.c, i)) {
        flush();
        if (cs.block) {
          const end = code.indexOf(cs.end, i + cs.c.length);
          const stop = end === -1 ? n : end + cs.end.length;
          tokens.push({ t: 'comment', v: code.slice(i, stop) });
          i = stop;
        } else {
          let stop = code.indexOf('\n', i);
          stop = stop === -1 ? n : stop;
          tokens.push({ t: 'comment', v: code.slice(i, stop) });
          i = stop;
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // string
    for (const q of stringStarts) {
      if (code.startsWith(q, i)) {
        flush();
        let j = i + q.length;
        while (j < n) {
          if (code[j] === '\\') {
            j += 2;
            continue;
          }
          if (code.startsWith(q, j)) {
            j += q.length;
            break;
          }
          j++;
        }
        tokens.push({ t: 'string', v: code.slice(i, j) });
        i = j;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    const rest = code.slice(i);
    if (kwRe) {
      const m = kwRe.exec(rest);
      if (m) {
        flush();
        tokens.push({ t: 'keyword', v: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (numRe) {
      const m = numRe.exec(rest);
      if (m) {
        flush();
        tokens.push({ t: 'number', v: m[0] });
        i += m[0].length;
        continue;
      }
    }
    const fm = fnRe.exec(rest);
    if (fm) {
      flush();
      tokens.push({ t: 'fn', v: fm[1] });
      i += fm[1].length;
      continue;
    }
    const ch = code[i];
    if (/[{}\[\]();,.:]/.test(ch)) {
      flush();
      tokens.push({ t: 'punct', v: ch });
      i++;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return tokens;
}

function tokenizeMarkdown(code: string): Token[] {
  const tokens: Token[] = [];
  const lines = code.split('\n');
  lines.forEach((line, idx) => {
    if (idx > 0) tokens.push({ t: 'plain', v: '\n' });
    const h = /^(#{1,6}\s.*)$/.exec(line);
    if (h) {
      tokens.push({ t: 'keyword', v: h[1] });
      return;
    }
    if (/^(\s*[-*]\s)/.test(line) || /^\s*\d+\.\s/.test(line)) {
      tokens.push({ t: 'keyword', v: line });
      return;
    }
    // inline code spans
    let i = 0;
    let buf = '';
    while (i < line.length) {
      if (line[i] === '`') {
        const end = line.indexOf('`', i + 1);
        const stop = end === -1 ? line.length : end + 1;
        if (buf) {
          tokens.push({ t: 'plain', v: buf });
          buf = '';
        }
        tokens.push({ t: 'string', v: line.slice(i, stop) });
        i = stop;
      } else {
        buf += line[i];
        i++;
      }
    }
    if (buf) tokens.push({ t: 'plain', v: buf });
  });
  return tokens;
}

function tokenizeHtml(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = code.length;
  let text = '';
  const flush = () => {
    if (text) {
      tokens.push({ t: 'plain', v: text });
      text = '';
    }
  };
  while (i < n) {
    if (code.startsWith('<!--', i)) {
      flush();
      const end = code.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      tokens.push({ t: 'comment', v: code.slice(i, stop) });
      i = stop;
      continue;
    }
    if (code[i] === '<') {
      flush();
      const end = code.indexOf('>', i);
      const stop = end === -1 ? n : end + 1;
      const tag = code.slice(i, stop);
      // tag name as keyword, attribute values as strings
      const nameM = /^(<\/?)([A-Za-z][\w-]*)?/.exec(tag);
      if (nameM) {
        tokens.push({ t: 'punct', v: nameM[1] });
        if (nameM[2]) tokens.push({ t: 'keyword', v: nameM[2] });
        let rest = tag.slice(nameM[0].length);
        // attribute strings
        const attrRe = /("[^"]*"|'[^']*')/g;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = attrRe.exec(rest))) {
          if (m.index > last) tokens.push({ t: 'plain', v: rest.slice(last, m.index) });
          tokens.push({ t: 'string', v: m[0] });
          last = m.index + m[0].length;
        }
        if (last < rest.length) tokens.push({ t: 'plain', v: rest.slice(last) });
      } else {
        tokens.push({ t: 'punct', v: tag });
      }
      i = stop;
      continue;
    }
    text += code[i];
    i++;
  }
  flush();
  return tokens;
}

/** Map a file path to a tokenizer language key. */
export function langFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'js';
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'js';
  if (['py', 'pyw'].includes(ext)) return 'py';
  if (ext === 'json' || ext === 'jsonc') return 'json';
  if (['md', 'mdx', 'markdown'].includes(ext)) return 'md';
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return 'html';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'sh';
  return 'plain';
}

// ---------------------------------------------------------------------------
// Line diff (LCS) — for `edit` tool calls: oldText -> newText
// ---------------------------------------------------------------------------

export type DiffLine = { kind: 'same' | 'del' | 'add'; text: string };

/** Compute a line-based diff between two texts. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const m = a.length;
  const n = b.length;
  // LCS table (cap size to avoid blowup on huge pastes)
  const cap = 4000;
  const mm = Math.min(m, cap);
  const nn = Math.min(n, cap);
  const dp: Uint16Array[] = Array.from({ length: mm + 1 }, () => new Uint16Array(nn + 1));
  for (let i = mm - 1; i >= 0; i--) {
    for (let j = nn - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < mm && j < nn) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < mm) {
    out.push({ kind: 'del', text: a[i++] });
  }
  while (j < nn) {
    out.push({ kind: 'add', text: b[j++] });
  }
  // If capped, append the remainder verbatim.
  for (let k = mm; k < m; k++) out.push({ kind: 'del', text: a[k] });
  for (let k = nn; k < n; k++) out.push({ kind: 'add', text: b[k] });
  return out;
}

// ---------------------------------------------------------------------------
// Unified-diff parsing — for `patch` tool calls
// ---------------------------------------------------------------------------

export type UDiffLine =
  | { kind: 'header'; text: string }
  | { kind: 'hunk'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'ctx'; text: string };

/** Parse unified diff text into renderable lines. */
export function parseUnifiedDiff(diff: string): UDiffLine[] {
  return diff.split('\n').map((line) => {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
      return { kind: 'header', text: line } as UDiffLine;
    }
    if (line.startsWith('@@')) return { kind: 'hunk', text: line } as UDiffLine;
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) } as UDiffLine;
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) } as UDiffLine;
    return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line } as UDiffLine;
  });
}

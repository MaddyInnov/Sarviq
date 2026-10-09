// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { langFromPath, lineDiff, parseUnifiedDiff, tokenize } from './highlight';

describe('tokenize', () => {
  it('highlights js keywords, strings, comments, numbers', () => {
    const toks = tokenize('const x = 42; // hi\nconst s = "str";', 'js');
    const kinds = toks.map((t) => t.t);
    expect(kinds).toContain('keyword');
    expect(kinds).toContain('number');
    expect(kinds).toContain('comment');
    expect(kinds).toContain('string');
    // round-trip: concatenation equals input
    expect(toks.map((t) => t.v).join('')).toBe('const x = 42; // hi\nconst s = "str";');
  });

  it('handles block comments and template strings', () => {
    const toks = tokenize('/* a */ `tpl ${x}`', 'js');
    expect(toks[0]).toMatchObject({ t: 'comment' });
    expect(toks.map((t) => t.v).join('')).toBe('/* a */ `tpl ${x}`');
  });

  it('tokenizes python', () => {
    const toks = tokenize('def f():\n    # c\n    return "x"', 'py');
    expect(toks.map((t) => t.v).join('')).toBe('def f():\n    # c\n    return "x"');
    expect(toks.some((t) => t.t === 'keyword' && t.v === 'def')).toBe(true);
  });

  it('returns plain for unknown language', () => {
    expect(tokenize('hello', 'cobol')).toEqual([{ t: 'plain', v: 'hello' }]);
  });

  it('handles unterminated string without hanging', () => {
    const toks = tokenize('const s = "oops', 'js');
    expect(toks.map((t) => t.v).join('')).toBe('const s = "oops');
  });
});

describe('langFromPath', () => {
  it('maps extensions', () => {
    expect(langFromPath('a.ts')).toBe('js');
    expect(langFromPath('a.tsx')).toBe('js');
    expect(langFromPath('a.py')).toBe('py');
    expect(langFromPath('a.json')).toBe('json');
    expect(langFromPath('a.md')).toBe('md');
    expect(langFromPath('a.css')).toBe('css');
    expect(langFromPath('a.sh')).toBe('sh');
    expect(langFromPath('a.html')).toBe('html');
    expect(langFromPath('Makefile')).toBe('plain');
  });
});

describe('lineDiff', () => {
  it('diffs changed lines', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(d).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('handles identical texts', () => {
    expect(lineDiff('x', 'x')).toEqual([{ kind: 'same', text: 'x' }]);
  });

  it('handles empty old text', () => {
    const d = lineDiff('', 'a\nb');
    expect(d.every((l) => l.kind === 'add')).toBe(true);
  });
});

describe('parseUnifiedDiff', () => {
  it('classifies diff lines', () => {
    const d = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n ctx');
    expect(d.map((l) => l.kind)).toEqual(['header', 'header', 'hunk', 'del', 'add', 'ctx']);
    expect(d[3]).toMatchObject({ kind: 'del', text: 'old' });
    expect(d[4]).toMatchObject({ kind: 'add', text: 'new' });
  });
});

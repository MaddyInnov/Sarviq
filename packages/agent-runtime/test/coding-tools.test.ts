// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodingTools } from '../src/tools/coding.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };

async function makeTools(): Promise<{ dir: string; byName: Map<string, ToolDefinition> }> {
  const dir = await mkdtemp(join(tmpdir(), 'coding-tools-'));
  const tools = createCodingTools({ workspaceDir: dir });
  return { dir, byName: new Map(tools.map((t) => [t.name, t])) };
}

const SAMPLE = ['line one', 'line two', 'line three', 'line four'].join('\n');

const GOOD_DIFF = [
  '--- a/notes.txt',
  '+++ b/notes.txt',
  '@@ -1,4 +1,4 @@',
  ' line one',
  '-line two',
  '+line 2 (edited)',
  ' line three',
  ' line four',
].join('\n');

describe('coding tools', () => {
  it('exposes the six expected tools with JSON Schema parameters', async () => {
    const { byName } = await makeTools();
    for (const name of ['patch', 'edit', 'glob', 'grep', 'lsp_definition', 'lsp_hover']) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      expect(tool?.parameters).toMatchObject({ type: 'object', properties: expect.anything() });
    }
  });

  it('patch applies a unified diff and returns applied files', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'notes.txt'), SAMPLE, 'utf8');
    const patch = byName.get('patch')!;
    const res = (await patch.handler({ diff: GOOD_DIFF }, CTX)) as {
      applied: string[];
      dryRun: boolean;
      files: { path: string; ok: boolean }[];
    };
    expect(res.dryRun).toBe(false);
    expect(res.applied).toEqual(['notes.txt']);
    expect(res.files[0].ok).toBe(true);
    const after = await readFile(join(dir, 'notes.txt'), 'utf8');
    expect(after).toContain('line 2 (edited)');
    expect(after).not.toContain('line two');
  });

  it('patch dryRun validates without writing', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'notes.txt'), SAMPLE, 'utf8');
    const patch = byName.get('patch')!;
    const res = (await patch.handler({ diff: GOOD_DIFF, dryRun: true }, CTX)) as {
      applied: string[];
      dryRun: boolean;
    };
    expect(res.dryRun).toBe(true);
    expect(res.applied).toEqual(['notes.txt']);
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe(SAMPLE);
  });

  it('patch fails cleanly on context mismatch and writes nothing', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'notes.txt'), 'completely different content', 'utf8');
    const patch = byName.get('patch')!;
    const res = (await patch.handler({ diff: GOOD_DIFF }, CTX)) as {
      applied: string[];
      files: { path: string; ok: boolean; error?: string }[];
    };
    expect(res.applied).toEqual([]);
    expect(res.files[0].ok).toBe(false);
    expect(res.files[0].error).toMatch(/mismatch/);
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('completely different content');
  });

  it('patch refuses diffs escaping the workspace', async () => {
    const { byName } = await makeTools();
    const patch = byName.get('patch')!;
    const evil = [
      '--- a/../evil.txt',
      '+++ b/../evil.txt',
      '@@ -0,0 +1 @@',
      '+pwned',
    ].join('\n');
    // New-file diff escaping the workspace: confine() throws -> per-file failure.
    const res = (await patch.handler({ diff: evil }, CTX)) as {
      files: { path: string; ok: boolean; error?: string }[];
    };
    expect(res.files[0].ok).toBe(false);
    expect(res.files[0].error).toMatch(/escapes workspace/);
  });

  it('edit replaces text and enforces expectedCount', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'code.ts'), 'const x = 1;\nconst x = 2;\n', 'utf8');
    const edit = byName.get('edit')!;
    // Default expectedCount=1 but two occurrences -> fail.
    await expect(edit.handler({ path: 'code.ts', oldText: 'const x', newText: 'let x' }, CTX)).rejects.toThrow(
      /expected 1/,
    );
    const ok = (await edit.handler(
      { path: 'code.ts', oldText: 'const x', newText: 'let x', expectedCount: 2 },
      CTX,
    )) as { replacements: number };
    expect(ok.replacements).toBe(2);
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('let x = 1;\nlet x = 2;\n');
    // Missing text -> fail.
    await expect(edit.handler({ path: 'code.ts', oldText: 'nope', newText: 'y' }, CTX)).rejects.toThrow(/not found/);
    // Traversal -> fail.
    await expect(edit.handler({ path: '../evil.ts', oldText: 'a', newText: 'b' }, CTX)).rejects.toThrow(
      /escapes workspace/,
    );
  });

  it('glob finds files with *, ?, ** patterns (capped at 200)', async () => {
    const { dir, byName } = await makeTools();
    await mkdir(join(dir, 'src', 'deep'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), '', 'utf8');
    await writeFile(join(dir, 'src', 'deep', 'b.ts'), '', 'utf8');
    await writeFile(join(dir, 'src', 'c.js'), '', 'utf8');
    const glob = byName.get('glob')!;
    const ts = (await glob.handler({ pattern: 'src/**/*.ts' }, CTX)) as { matches: string[] };
    expect(ts.matches.sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
    const one = (await glob.handler({ pattern: 'src/?.ts' }, CTX)) as { matches: string[] };
    expect(one.matches).toEqual(['src/a.ts']);
    const all = (await glob.handler({ pattern: '**' }, CTX)) as { matches: string[]; truncated: boolean };
    expect(all.matches.length).toBe(3);
    expect(all.truncated).toBe(false);
  });

  it('grep searches content with line numbers and skips binary files', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'app.ts'), 'const token = 1;\n// token comment\nconst other = 2;\n', 'utf8');
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x74, 0x6f, 0x6b, 0x65, 0x6e]), 'utf8');
    const grep = byName.get('grep')!;
    const res = (await grep.handler({ pattern: 'token' }, CTX)) as {
      matches: { path: string; line: number; text: string }[];
    };
    // blob.bin contains the bytes "token" but must be skipped as binary.
    expect(res.matches.map((m) => m.path)).toEqual(['app.ts', 'app.ts']);
    expect(res.matches[0].line).toBe(1);
    expect(res.matches[1].line).toBe(2);
    const filtered = (await grep.handler({ pattern: 'token', filePattern: '*.js' }, CTX)) as {
      matches: unknown[];
    };
    expect(filtered.matches).toEqual([]);
    await expect(grep.handler({ pattern: '([' }, CTX)).rejects.toThrow(/invalid regex/);
  });

  it('lsp_definition and lsp_hover return degraded when no server is on PATH', async () => {
    const { byName } = await makeTools();
    // typescript-language-server is not installed in this environment; both
    // tools must degrade gracefully instead of throwing.
    const def = byName.get('lsp_definition')!;
    const hover = byName.get('lsp_hover')!;
    const d = (await def.handler({ path: 'x.ts', line: 0, character: 0 }, CTX)) as { degraded?: boolean; error?: string };
    const h = (await hover.handler({ path: 'x.ts', line: 0, character: 0 }, CTX)) as { degraded?: boolean; error?: string };
    expect(d.degraded).toBe(true);
    expect(d.error).toMatch(/not available/);
    expect(h.degraded).toBe(true);
    expect(h.error).toMatch(/not available/);
  });
});

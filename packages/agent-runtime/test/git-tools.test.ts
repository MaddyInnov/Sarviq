// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { __git_test__, createGitTools } from '../src/tools/git.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };

async function makeTools(): Promise<{ dir: string; byName: Map<string, ToolDefinition> }> {
  const dir = await mkdtemp(join(tmpdir(), 'git-tools-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  const tools = createGitTools({ workspaceDir: dir });
  return { dir, byName: new Map(tools.map((t) => [t.name, t])) };
}

describe('git tools', () => {
  it('registers all five tools', async () => {
    const { byName } = await makeTools();
    for (const name of ['git_status', 'git_diff', 'git_commit', 'git_branch', 'git_push']) {
      expect(byName.has(name), name).toBe(true);
    }
  });

  it('confine rejects traversal', () => {
    expect(() => __git_test__.confine('/tmp/ws', '../etc')).toThrow(/escapes/);
    expect(() => __git_test__.confine('/tmp/ws', '/etc/passwd')).toThrow(/escapes/);
  });

  it('git_status shows clean tree', async () => {
    const { byName } = await makeTools();
    const r = (await byName.get('git_status')!.handler({}, CTX)) as { status: string };
    expect(typeof r.status).toBe('string');
  });

  it('git_diff + git_commit round-trip', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'hello.txt'), 'hello\n');
    const diff = (await byName.get('git_diff')!.handler({}, CTX)) as { diff: string };
    expect(diff.diff).toContain('hello.txt');
    const commit = (await byName.get('git_commit')!.handler({ message: 'add hello' }, CTX)) as {
      committed: boolean;
    };
    expect(commit.committed).toBe(true);
    const status = (await byName.get('git_status')!.handler({}, CTX)) as { status: string };
    // Clean tree: only the branch header line (## master), no file entries.
    const fileLines = status.status.split('\n').filter((l) => l && !l.startsWith('##'));
    expect(fileLines).toEqual([]);
  });

  it('git_commit rejects empty message', async () => {
    const { byName } = await makeTools();
    await expect(byName.get('git_commit')!.handler({ message: '' }, CTX)).rejects.toThrow(/required/);
  });

  it('git_branch create/switch/list', async () => {
    const { dir, byName } = await makeTools();
    await writeFile(join(dir, 'base.txt'), 'base\n');
    await byName.get('git_commit')!.handler({ message: 'base commit' }, CTX);
    const created = (await byName.get('git_branch')!.handler({ action: 'create', name: 'feature/x' }, CTX)) as {
      branch: string;
    };
    expect(created.branch).toBe('feature/x');
    const listed = (await byName.get('git_branch')!.handler({ action: 'list' }, CTX)) as {
      branches: string[];
    };
    expect(listed.branches.some((b) => b.includes('feature/x'))).toBe(true);
  });

  it('git_branch rejects bad names', async () => {
    const { byName } = await makeTools();
    await expect(
      byName.get('git_branch')!.handler({ action: 'create', name: '-bad' }, CTX),
    ).rejects.toThrow(/Invalid/);
    await expect(
      byName.get('git_branch')!.handler({ action: 'create', name: 'a..b' }, CTX),
    ).rejects.toThrow(/Invalid/);
  });

  it('git_push fails gracefully with no remote', async () => {
    const { byName } = await makeTools();
    await expect(byName.get('git_push')!.handler({}, CTX)).rejects.toThrow(/git push failed/);
  });
});

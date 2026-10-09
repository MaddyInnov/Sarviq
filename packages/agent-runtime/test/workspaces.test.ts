// SPDX-License-Identifier: Apache-2.0
// Tests for per-bot workspaces (Octop-style isolation).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  makeWorkspaceResolver,
  resolveBotWorkspaceDir,
  resolveWorkspaceDir,
  validateBotWorkspace,
} from '../src/workspaces.js';
import type { ToolContext } from '../src/types.js';

let dataDir: string;
let globalDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ws-test-data-'));
  globalDir = mkdtempSync(join(tmpdir(), 'ws-test-global-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
});

const ctx = (botId: string): ToolContext => ({ sessionId: 's1', botId });

describe('validateBotWorkspace', () => {
  it('accepts empty (→ global workspace)', () => {
    expect(validateBotWorkspace('', dataDir)).toBe('');
    expect(validateBotWorkspace(null, dataDir)).toBe('');
    expect(validateBotWorkspace(undefined, dataDir)).toBe('');
  });
  it('accepts simple relative names', () => {
    expect(validateBotWorkspace('coder', dataDir)).toBe('coder');
    expect(validateBotWorkspace('my-bot_2', dataDir)).toBe('my-bot_2');
  });
  it('rejects traversal and weird chars', () => {
    expect(() => validateBotWorkspace('../evil', dataDir)).toThrow();
    expect(() => validateBotWorkspace('a/../../b', dataDir)).toThrow();
    expect(() => validateBotWorkspace('.hidden', dataDir)).toThrow();
    expect(() => validateBotWorkspace('has space', dataDir)).toThrow();
  });
  it('accepts absolute paths inside dataDir', () => {
    const abs = join(dataDir, 'custom');
    expect(validateBotWorkspace(abs, dataDir)).toBe(resolve(abs));
  });
  it('rejects absolute paths outside dataDir', () => {
    expect(() => validateBotWorkspace('/etc/passwd', dataDir)).toThrow();
    expect(() => validateBotWorkspace('/tmp/evil', dataDir)).toThrow();
  });
});

describe('resolveBotWorkspaceDir', () => {
  it('falls back to global when unset', () => {
    expect(resolveBotWorkspaceDir({ globalWorkspaceDir: globalDir, dataDir })).toBe(resolve(globalDir));
    expect(resolveBotWorkspaceDir({ botWorkspace: '', globalWorkspaceDir: globalDir, dataDir })).toBe(
      resolve(globalDir),
    );
  });
  it('resolves relative against <dataDir>/workspaces and creates it', () => {
    const dir = resolveBotWorkspaceDir({ botWorkspace: 'coder', globalWorkspaceDir: globalDir, dataDir });
    expect(dir).toBe(resolve(join(dataDir, 'workspaces', 'coder')));
    // directory was created
    expect(existsSync(dir)).toBe(true);
  });
  it('throws when a stored absolute path escapes dataDir (fail closed)', () => {
    expect(() =>
      resolveBotWorkspaceDir({ botWorkspace: '/etc/evil', globalWorkspaceDir: globalDir, dataDir }),
    ).toThrow();
  });
});

describe('makeWorkspaceResolver', () => {
  it('resolves per-bot workspaces from context', () => {
    const resolver = makeWorkspaceResolver({
      getBotWorkspace: (botId) => (botId === 'coder' ? 'coder' : undefined),
      globalWorkspaceDir: globalDir,
      dataDir,
    });
    expect(resolver(ctx('coder'))).toBe(resolve(join(dataDir, 'workspaces', 'coder')));
    expect(resolver(ctx('helper'))).toBe(resolve(globalDir));
  });
  it('string source passes through (backward compat)', () => {
    expect(resolveWorkspaceDir(globalDir, ctx('any'))).toBe(globalDir);
  });
});

describe('per-bot isolation', () => {
  it('two bots get different roots', () => {
    const a = resolveBotWorkspaceDir({ botWorkspace: 'bot-a', globalWorkspaceDir: globalDir, dataDir });
    const b = resolveBotWorkspaceDir({ botWorkspace: 'bot-b', globalWorkspaceDir: globalDir, dataDir });
    expect(a).not.toBe(b);
    expect(a.startsWith(resolve(dataDir))).toBe(true);
    expect(b.startsWith(resolve(dataDir))).toBe(true);
  });

  it('tools confine per-bot: bot A cannot read bot B files', async () => {
    const { createBuiltInTools } = await import('../src/tools/builtin.js');
    const resolver = makeWorkspaceResolver({
      getBotWorkspace: (botId) => (botId === 'bot-a' ? 'bot-a' : botId === 'bot-b' ? 'bot-b' : undefined),
      globalWorkspaceDir: globalDir,
      dataDir,
    });
    const tools = createBuiltInTools({ workspaceDir: resolver });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const write = byName.get('write_file')!;
    const read = byName.get('read_file')!;

    // bot-a writes a secret file in its own workspace
    await write.handler({ path: 'secret.txt', content: 'bot-a-secret' }, ctx('bot-a'));
    // bot-a can read it back
    expect(await read.handler({ path: 'secret.txt' }, ctx('bot-a'))).toBe('bot-a-secret');
    // bot-b cannot see it (different root → file not found)
    await expect(read.handler({ path: 'secret.txt' }, ctx('bot-b'))).rejects.toThrow();
    // traversal from bot-a into bot-b's dir is rejected by confine
    await expect(read.handler({ path: '../bot-b/secret.txt' }, ctx('bot-a'))).rejects.toThrow();
  });
});

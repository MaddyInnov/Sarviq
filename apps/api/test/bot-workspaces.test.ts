// SPDX-License-Identifier: Apache-2.0
// Tests for per-bot workspace API (PUT /bots/:id/workspace,
// GET /bots/:id/files, GET /bots/:id/files/content).

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { applyBotWorkspaces, saveBotWorkspace } from '../src/bot-workspaces.js';
import { resolveBotWorkspaceDir } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';

let dataDir: string;
let globalDir: string;

function makeBot(id: string): BotConfig {
  return {
    id,
    name: id,
    description: '',
    systemPrompt: '',
    provider: 'groq',
    model: 'test',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bw-api-data-'));
  globalDir = mkdtempSync(join(tmpdir(), 'bw-api-global-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
});

describe('saveBotWorkspace', () => {
  it('saves and applies a relative workspace', () => {
    const bots = [makeBot('coder')];
    const saved = saveBotWorkspace(dataDir, bots, 'coder', 'coder');
    expect(saved).toBe('coder');
    expect(bots[0].workspace).toBe('coder');
    // persisted — re-apply onto fresh bots
    const fresh = [makeBot('coder')];
    applyBotWorkspaces(fresh, dataDir);
    expect(fresh[0].workspace).toBe('coder');
  });

  it('empty clears the workspace (→ global)', () => {
    const bots = [makeBot('coder')];
    saveBotWorkspace(dataDir, bots, 'coder', 'coder');
    expect(bots[0].workspace).toBe('coder');
    saveBotWorkspace(dataDir, bots, 'coder', '');
    expect(bots[0].workspace).toBeUndefined();
  });

  it('rejects unknown bot and bad values', () => {
    const bots = [makeBot('coder')];
    expect(() => saveBotWorkspace(dataDir, bots, 'nope', 'x')).toThrow(/Unknown bot/);
    expect(() => saveBotWorkspace(dataDir, bots, 'coder', '../evil')).toThrow();
    expect(() => saveBotWorkspace(dataDir, bots, 'coder', '/etc/passwd')).toThrow();
  });

  it('resolves the bot root for the files API', () => {
    const bots = [makeBot('coder')];
    saveBotWorkspace(dataDir, bots, 'coder', 'coder');
    const root = resolveBotWorkspaceDir({
      botWorkspace: bots[0].workspace,
      globalWorkspaceDir: globalDir,
      dataDir,
    });
    // bot can write; file lands isolated from the global workspace
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'hello.txt'), 'hi');
    expect(existsSync(join(root, 'hello.txt'))).toBe(true);
    expect(existsSync(join(globalDir, 'hello.txt'))).toBe(false);
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hi');
  });

  it('ignores invalid persisted values at boot (fail open to global)', () => {
    const bots = [makeBot('coder')];
    writeFileSync(join(dataDir, 'bot-workspaces.json'), JSON.stringify({ coder: '../evil' }));
    applyBotWorkspaces(bots, dataDir);
    expect(bots[0].workspace).toBeUndefined();
  });
});

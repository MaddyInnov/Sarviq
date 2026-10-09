// SPDX-License-Identifier: Apache-2.0
// Spaces runtime plumbing: per-turn API-key override in createProvider and
// per-turn workspace override in the workspace resolver. No network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProvider } from '../src/providers/factory.js';
import { makeWorkspaceResolver } from '../src/workspaces.js';
import type { ToolContext } from '../src/types.js';

let dir: string;
const ENV_KEY = 'GROQ_API_KEY';
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-space-runtime-'));
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe('createProvider apiKey override', () => {
  it('builds a provider without a configured key when an override is given', () => {
    // No GROQ_API_KEY in env and no local file — would throw without override.
    const provider = createProvider('groq', { apiKey: 'sk-space-override' });
    expect(provider).toBeDefined();
  });

  it('still throws without any key when no override is given', () => {
    expect(() => createProvider('groq')).toThrow(/Missing GROQ_API_KEY/);
  });
});

describe('makeWorkspaceResolver space override', () => {
  it('prefers ctx.spaceWorkspaceOverride over the bot workspace', () => {
    const resolve = makeWorkspaceResolver({
      getBotWorkspace: () => 'bot-ws',
      globalWorkspaceDir: join(dir, 'global'),
      dataDir: dir,
    });
    const ctx = { sessionId: 's', botId: 'b', spaceWorkspaceOverride: 'space-ws' } as ToolContext;
    expect(resolve(ctx)).toBe(join(dir, 'workspaces', 'space-ws'));
  });

  it('falls back to bot/global workspace when no override is set', () => {
    const resolve = makeWorkspaceResolver({
      getBotWorkspace: () => '',
      globalWorkspaceDir: join(dir, 'global'),
      dataDir: dir,
    });
    const ctx = { sessionId: 's', botId: 'b' } as ToolContext;
    expect(resolve(ctx)).toBe(join(dir, 'global'));
  });

  it('fails closed when the override escapes the data dir', () => {
    const resolve = makeWorkspaceResolver({
      getBotWorkspace: () => '',
      globalWorkspaceDir: join(dir, 'global'),
      dataDir: dir,
    });
    const ctx = { sessionId: 's', botId: 'b', spaceWorkspaceOverride: '/etc' } as ToolContext;
    expect(() => resolve(ctx)).toThrow(/escapes the data directory/);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Tests for AgentRuntime.addContextProvider (feature interconnection):
// provider output lands in the system prompt after memoryContext, and a
// throwing provider never breaks the turn.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { LLMProvider } from '../src/providers/factory.js';
import type { GovernanceDecision } from '../src/governance.js';
import type { BotConfig, StreamEvent } from '../src/types.js';

let dir: string;

const BOT: BotConfig = {
  id: 'bot-1',
  name: 'Test Bot',
  description: 'test',
  systemPrompt: 'You are a test bot.',
  provider: 'mock',
  model: 'mock-model',
  skills: [],
  tools: [],
  mcpServers: [],
};

class AllowGateway {
  async classify(): Promise<GovernanceDecision> {
    return 'allow';
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: 'allow' };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return 'approved';
  }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

/** Runtime subclass that injects a scripted MockProvider (per the docs on resolveProvider). */
class TestRuntime extends AgentRuntime {
  readonly mock = new MockProvider([{ content: 'done' }]);
  protected override resolveProvider(_providerId: string): LLMProvider {
    return this.mock;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-ctxprov-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(): TestRuntime {
  return new TestRuntime({
    dbPath: join(dir, 'agent.db'),
    skillsDir: dir,
    governance: new AllowGateway() as never,
    toolRegistry: new Map(),
    defaultProviderId: 'mock',
  });
}

function systemText(rt: TestRuntime): string {
  const first = rt.mock.calls[0];
  expect(first).toBeDefined();
  const sys = first!.messages.find((m) => m.role === 'system');
  expect(sys).toBeDefined();
  return sys!.content;
}

describe('addContextProvider', () => {
  it('appends provider output after memoryContext in the system prompt', async () => {
    const rt = makeRuntime();
    const seen: string[] = [];
    rt.addContextProvider(async ({ bot, sessionId }) => {
      seen.push(`${bot.id}:${sessionId}`);
      return '# Attached reference material\nnote body here';
    });
    rt.addContextProvider(() => undefined); // empty providers add nothing
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: BOT,
      message: 'hi',
      sessionId: 'sess-1',
      memoryContext: 'memory block',
      onEvent: (e) => void events.push(e),
    });
    expect(seen).toEqual(['bot-1:sess-1']);
    const sys = systemText(rt);
    expect(sys).toContain('You are a test bot.');
    expect(sys).toContain('memory block');
    expect(sys).toContain('# Attached reference material\nnote body here');
    expect(sys.indexOf('memory block')).toBeLessThan(sys.indexOf('# Attached reference material'));
    rt.close();
  });

  it('a throwing provider never breaks the turn', async () => {
    const rt = makeRuntime();
    rt.addContextProvider(() => {
      throw new Error('provider exploded');
    });
    const events: StreamEvent[] = [];
    await expect(
      rt.runTurn({ bot: BOT, message: 'hi', sessionId: 'sess-2', onEvent: (e) => void events.push(e) }),
    ).resolves.toBeDefined();
    expect(systemText(rt)).toContain('You are a test bot.');
    rt.close();
  });
});

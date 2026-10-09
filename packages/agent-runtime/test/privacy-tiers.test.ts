// SPDX-License-Identifier: Apache-2.0
// Privacy tiers across memory and the runtime provider choke point:
// - local-only atoms are tagged at write time and excluded from cloud
//   prompts by default (recallForPrompt / recallHybrid)
// - AgentRuntime.runTurn asserts the EgressGate before provider.chat when
//   the host attaches tier-tagged egress items; a local-only item denies
//   the call fail-closed with an audit entry, and the provider is never
//   touched.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EgressGate, PrivacyTierDeniedError } from '@mvp/governance';
import { TieredMemoryStore } from '../src/memory.js';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-privacy-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TieredMemoryStore privacy tiers', () => {
  it('tags atoms at write time (default cloud-ok, overridable)', () => {
    const store = new TieredMemoryStore(dir);
    const id1 = store.storeAtom('b1', { fact: 'The user likes tea.', entities: [], confidence: 0.9 }, 't1');
    const id2 = store.storeAtom(
      'b1',
      { fact: 'The user told me their home address.', entities: [], confidence: 0.9 },
      't1',
      'local-only',
    );
    const atoms = new Map(store.getAtoms('b1').map((a) => [a.id, a]));
    expect(atoms.get(id1)?.tier).toBe('cloud-ok');
    expect(atoms.get(id2)?.tier).toBe('local-only');
  });

  it('recallForPrompt excludes local-only atoms from cloud prompts by default', () => {
    const store = new TieredMemoryStore(dir);
    store.storeAtom('b1', { fact: 'The user likes tea.', entities: ['tea'], confidence: 0.9 }, 't1');
    store.storeAtom(
      'b1',
      { fact: 'The user home address is secret street.', entities: ['address'], confidence: 0.9 },
      't1',
      'local-only',
    );
    const block = store.recallForPrompt('b1', 'user address tea');
    expect(block).toContain('tea');
    expect(block).not.toContain('secret street');
    // Explicitly opting into local-only brings it back (local model path).
    const local = store.recallForPrompt('b1', 'user address tea', 2000, { maxTier: 'local-only' });
    expect(local).toContain('secret street');
  });

  it('recallHybrid excludes local-only atoms by default', () => {
    const store = new TieredMemoryStore(dir);
    store.storeAtom('b1', { fact: 'The user likes tea.', entities: ['tea'], confidence: 0.9 }, 't1');
    store.storeAtom(
      'b1',
      { fact: 'The user home address is secret street.', entities: ['address'], confidence: 0.9 },
      't1',
      'local-only',
    );
    const hits = store.recallHybrid('b1', 'user address tea');
    expect(hits.every((h) => h.atom.tier !== 'local-only')).toBe(true);
    const localHits = store.recallHybrid('b1', 'user address tea', 5, 'local-only');
    expect(localHits.some((h) => h.atom.fact.includes('secret street'))).toBe(true);
  });

  it('recordEvent tags tiers at write time', () => {
    const store = new TieredMemoryStore(dir);
    const ev = store.recordEvent('b1', 's1', 'user', 'hello');
    expect(ev.tier).toBe('cloud-ok');
    const ev2 = store.recordEvent('b1', 's1', 'user', 'my ssn', [], 'local-only');
    expect(ev2.tier).toBe('local-only');
  });
});

// ---- Runtime provider choke point ------------------------------------------

class FakeGateway implements GovernanceGateway {
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

function testBot(): BotConfig {
  return {
    id: 'bot-test',
    name: 'Test Bot',
    description: 'A bot for tests',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

function makeRuntime(provider: MockProvider): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): MockProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: new FakeGateway(),
    toolRegistry: new Map(),
    defaultProviderId: 'mock',
  });
}

describe('AgentRuntime privacy gate at provider.chat', () => {
  it('denies the turn when a local-only item would egress, auditing it, without touching the provider', async () => {
    const audited: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const gate = new EgressGate((action, detail) => audited.push({ action, detail }));
    const provider = new MockProvider([{ content: 'hello' }]);
    const runtime = makeRuntime(provider);

    let err: unknown;
    try {
      await runtime.runTurn({
        bot: testBot(),
        message: 'hi',
        onEvent: () => {},
        privacyGate: gate,
        egressItems: [
          { id: 'atom-1', tier: 'cloud-ok' },
          { id: 'vault:prod-key', tier: 'local-only' },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PrivacyTierDeniedError);
    // Provider never called — zero network I/O happened.
    expect(provider.calls.length).toBe(0);
    // Audit entry written with ids/tiers only.
    expect(audited.length).toBe(1);
    expect(audited[0].action).toBe('privacy.egress_denied');
    const detailJson = JSON.stringify(audited[0].detail);
    expect(detailJson).toContain('vault:prod-key');
    expect(detailJson).toContain('provider.chat');
  });

  it('lets the turn proceed when every item is cloud-safe', async () => {
    const gate = new EgressGate();
    const provider = new MockProvider([{ content: 'hello there' }]);
    const runtime = makeRuntime(provider);
    const events: string[] = [];
    await runtime.runTurn({
      bot: testBot(),
      message: 'hi',
      onEvent: (e) => {
        if (e.type === 'token') events.push(String(e.content));
      },
      privacyGate: gate,
      egressItems: [{ id: 'atom-1', tier: 'cloud-ok' }],
    });
    expect(provider.calls.length).toBe(1);
    expect(events.join('')).toContain('hello there');
  });

  it('no gate configured → previous behavior (provider called)', async () => {
    const provider = new MockProvider([{ content: 'hi' }]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn({ bot: testBot(), message: 'hi', onEvent: () => {} });
    expect(provider.calls.length).toBe(1);
  });
});

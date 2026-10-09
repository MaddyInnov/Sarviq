// SPDX-License-Identifier: Apache-2.0
// Tests for GovernanceAdapter.simulatePolicy(): side-effect-free policy
// dry-run with per-bot policy merging, mirroring evaluate()'s merge logic.

import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { GovernanceAdapter } from '../src/governance-adapter.js';
import type { BotConfig, BotPolicyRule } from '@mvp/agent-runtime';

function makeAdapter(bots: BotConfig[] = []) {
  const real = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
  const byId = new Map(bots.map((b) => [b.id, b]));
  const adapter = new GovernanceAdapter(real, {
    getBotConfig: (id) => byId.get(id),
    globalPolicy: DEFAULT_POLICY,
  });
  return { real, adapter };
}

function botWithRules(id: string, rules: BotPolicyRule[]): BotConfig {
  return {
    id,
    name: id,
    provider: 'groq',
    model: 'test',
    skills: [],
    tools: [],
    mcpServers: [],
    policy: { rules },
  } as BotConfig;
}

afterEach(() => {
  // Gateways are per-test; sqlite :memory: closes on GC. Nothing to tear down.
});

describe('simulatePolicy', () => {
  it('evaluates against the global policy when the bot has no rules', async () => {
    const { real, adapter } = makeAdapter();
    const sim = await adapter.simulatePolicy('bot-1', 'write_file', { path: 'a.txt' });
    expect(sim.effect).toBe('require-approval');
    expect(sim.matchedRuleId).toBe('approval-file-writes');
    expect(sim.simulated).toBe(true);
    // No side effects on the real gateway.
    expect(real.listApprovals('pending')).toHaveLength(0);
    expect(real.listAudit(100)).toHaveLength(0);
  });

  it('merges bot rules ahead of the global policy (first match wins)', async () => {
    const { adapter } = makeAdapter([
      botWithRules('bot-9', [
        { id: 'bot-deny-write', toolPattern: '^write_file$', effect: 'deny', reason: 'bot locks writes' },
      ]),
    ]);
    const sim = await adapter.simulatePolicy('bot-9', 'write_file', { path: 'a.txt' });
    expect(sim.effect).toBe('deny');
    expect(sim.matchedRuleId).toBe('bot-deny-write');
    expect(sim.reason).toBe('bot locks writes');
  });

  it('bot rules can loosen the global default without touching it', async () => {
    const { adapter } = makeAdapter([
      botWithRules('bot-loose', [
        { id: 'bot-allows-mystery', toolPattern: '^mystery_tool$', effect: 'allow', reason: 'bot trusts it' },
      ]),
    ]);
    const sim = await adapter.simulatePolicy('bot-loose', 'mystery_tool', {});
    expect(sim.effect).toBe('allow');
    expect(sim.matchedRuleId).toBe('bot-allows-mystery');
  });

  it('unknown bot id falls back to the global policy', async () => {
    const { adapter } = makeAdapter();
    const sim = await adapter.simulatePolicy('no-such-bot', 'web_search', { q: 'x' });
    expect(sim.effect).toBe('allow');
    expect(sim.matchedRuleId).toBe('allow-reads');
  });

  it('surfaces catastrophic hard floors in simulation', async () => {
    const { adapter } = makeAdapter();
    const sim = await adapter.simulatePolicy('bot-1', 'run_command', { command: 'rm -rf /' });
    expect(sim.effect).toBe('deny');
    expect(sim.hardFloor?.tier).toBe('catastrophic');
    expect(sim.wouldCreateApproval).toBe(false);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Tests for GovernanceGateway.simulate(): side-effect-free policy dry-run.

import { describe, expect, it, afterEach } from 'vitest';
import {
  GovernanceGateway,
  DEFAULT_POLICY,
  type EvalContext,
  type Policy,
} from '../src/index.js';

const CTX: EvalContext = {
  sessionId: 'sess-sim',
  botId: 'bot-sim',
  actor: 'test-user',
};

const gateways: GovernanceGateway[] = [];
function fresh(policy: Policy = DEFAULT_POLICY, hardFloors?: { enabled: boolean }): GovernanceGateway {
  const gw = new GovernanceGateway({ dbPath: ':memory:', policy, ...(hardFloors ? { hardFloors } : {}) });
  gateways.push(gw);
  return gw;
}

afterEach(() => {
  while (gateways.length > 0) {
    gateways.pop()?.close();
  }
});

describe('simulate()', () => {
  it('mirrors the live decision for an auto-allowed read', async () => {
    const gw = fresh();
    const sim = await gw.simulate('web_search', { query: 'x' });
    const live = await gw.evaluate('web_search', { query: 'x' }, CTX);
    expect(sim.effect).toBe('allow');
    expect(sim.effect).toBe(live.effect);
    expect(sim.matchedRuleId).toBe('allow-reads');
    expect(sim.wouldCreateApproval).toBe(false);
    expect(sim.simulated).toBe(true);
  });

  it('mirrors require-approval for writes without minting an approval', async () => {
    const gw = fresh();
    const sim = await gw.simulate('write_file', { path: 'a.txt' });
    expect(sim.effect).toBe('require-approval');
    expect(sim.wouldCreateApproval).toBe(true);
    expect(sim.matchedRuleId).toBe('approval-file-writes');
    // No approval record was created…
    expect(gw.listApprovals('pending')).toHaveLength(0);
    // …and nothing was audited.
    expect(gw.listAudit(100)).toHaveLength(0);
  });

  it('mirrors deny effects from explicit rules', async () => {
    const gw = fresh({
      defaultEffect: 'require-approval',
      rules: [
        {
          id: 'deny-mystery',
          toolPattern: '^mystery_tool$',
          effect: 'deny',
          reason: 'test rule',
        },
      ],
    });
    const sim = await gw.simulate('mystery_tool', {});
    expect(sim.effect).toBe('deny');
    expect(sim.matchedRuleId).toBe('deny-mystery');
    expect(sim.reason).toBe('test rule');
    expect(gw.listApprovals('pending')).toHaveLength(0);
    expect(gw.listAudit(100)).toHaveLength(0);
  });

  it('surfaces hard-floor hits (destructive → approval, catastrophic → deny)', async () => {
    const gw = fresh();
    // Catastrophic tier: unconditional deny, no approval possible.
    const cat = await gw.simulate('run_command', { command: 'rm -rf /' });
    expect(cat.effect).toBe('deny');
    expect(cat.wouldCreateApproval).toBe(false);
    expect(cat.hardFloor?.tier).toBe('catastrophic');
    // Denylist: unconditional deny, flagged. (Hard floors also match mkfs,
    // so disable them here to isolate the denylist path.)
    const gwNoFloors = fresh(DEFAULT_POLICY, { enabled: false });
    const dl = await gwNoFloors.simulate('run_command', { command: 'mkfs /dev/sda' });
    expect(dl.effect).toBe('deny');
    expect(dl.denylist).toBe(true);
    // Nothing persisted by either simulation.
    expect(gw.listApprovals('pending')).toHaveLength(0);
    expect(gw.listAudit(100)).toHaveLength(0);
  });

  it('evaluates against an explicit per-bot policy when given', async () => {
    const gw = fresh();
    const botPolicy: Policy = {
      defaultEffect: 'require-approval',
      rules: [
        { id: 'bot-allows-search', toolPattern: '^web_search$', effect: 'allow', reason: 'bot loosens reads' },
      ],
    };
    const sim = await gw.simulate('web_search', { query: 'x' }, botPolicy);
    expect(sim.effect).toBe('allow');
    expect(sim.matchedRuleId).toBe('bot-allows-search');
  });

  it('falls back to the default effect with no matched rule', async () => {
    const gw = fresh();
    const sim = await gw.simulate('some_mystery_tool', { foo: 'bar' });
    expect(sim.effect).toBe('require-approval');
    expect(sim.matchedRuleId).toBeUndefined();
    expect(sim.reason).toBe('default policy');
  });
});

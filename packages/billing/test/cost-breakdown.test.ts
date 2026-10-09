// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CostTracker } from '../src/cost-breakdown.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'cost-test-')), 'billing.db');
}

const trackers: CostTracker[] = [];
function fresh(): CostTracker {
  const t = new CostTracker(tmpDb());
  trackers.push(t);
  return t;
}
afterEach(() => {
  for (const t of trackers.splice(0)) t.close();
});

describe('CostTracker.record', () => {
  it('records events with explicit cost and validates input', () => {
    const t = fresh();
    const e = t.record({
      feature: 'chat',
      step: 'provider.chat',
      model: 'llama-3.3-70b',
      inputTokens: 1000,
      outputTokens: 500,
      costCents: 42,
      sessionId: 's1',
      botId: 'b1',
    });
    expect(e.feature).toBe('chat');
    expect(e.costCents).toBe(42);
    expect(e.model).toBe('llama-3.3-70b');
    expect(e.ts).toBeGreaterThan(0);

    expect(() => t.record({ feature: '', step: 'x', inputTokens: 1, outputTokens: 1 })).toThrow();
    expect(() => t.record({ feature: 'f', step: 'x', inputTokens: -1, outputTokens: 1 })).toThrow();
    expect(() => t.record({ feature: 'f', step: 'x', inputTokens: 1.5, outputTokens: 1 })).toThrow();
  });

  it('estimates cost from tokens when costCents is omitted', () => {
    const t = fresh();
    // 1M in + 1M out at default prices (30 + 60 cents).
    const e = t.record({ feature: 'chat', step: 'provider.chat', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(e.costCents).toBe(90);
  });
});

describe('CostTracker.breakdown', () => {
  it('aggregates by feature and by step with totals', () => {
    const t = fresh();
    t.record({ feature: 'chat', step: 'provider.chat', inputTokens: 100, outputTokens: 50, costCents: 10 });
    t.record({ feature: 'chat', step: 'provider.chat', inputTokens: 200, outputTokens: 50, costCents: 20 });
    t.record({ feature: 'chat', step: 'tool.execute', inputTokens: 0, outputTokens: 0, costCents: 5 });
    t.record({ feature: 'workflows', step: 'run', inputTokens: 1000, outputTokens: 0, costCents: 100 });

    const b = t.breakdown({ period: 'all' });
    expect(b.totals).toEqual({ events: 4, inputTokens: 1300, outputTokens: 100, costCents: 135 });
    expect(b.byFeature.map((f) => f.feature)).toEqual(['workflows', 'chat']); // cost desc
    const chat = b.byFeature.find((f) => f.feature === 'chat')!;
    expect(chat).toMatchObject({ events: 3, inputTokens: 300, outputTokens: 100, costCents: 35 });

    const steps = new Map(b.byStep.map((s) => [`${s.feature}/${s.step}`, s.costCents]));
    expect(steps.get('chat/provider.chat')).toBe(30);
    expect(steps.get('chat/tool.execute')).toBe(5);
    expect(steps.get('workflows/run')).toBe(100);
  });

  it('narrows by feature and by explicit time range', () => {
    const t = fresh();
    t.record({ feature: 'chat', step: 'a', inputTokens: 10, outputTokens: 0, costCents: 1 });
    t.record({ feature: 'other', step: 'b', inputTokens: 10, outputTokens: 0, costCents: 2 });

    const narrowed = t.breakdown({ period: 'all', feature: 'chat' });
    expect(narrowed.totals.events).toBe(1);
    expect(narrowed.byFeature.length).toBe(1);

    const now = Date.now();
    expect(t.breakdown({ since: now + 60_000, until: now + 120_000 }).totals.events).toBe(0);
    expect(t.breakdown({ since: 0, until: now + 60_000 }).totals.events).toBe(2);
  });

  it('period=day only includes today', () => {
    const t = fresh();
    t.record({ feature: 'chat', step: 'a', inputTokens: 1, outputTokens: 0, costCents: 1 });
    const b = t.breakdown({ period: 'day' });
    expect(b.totals.events).toBe(1);
    expect(b.since).toBeLessThanOrEqual(Date.now());
    expect(() => t.breakdown({ period: 'fortnight' as never })).toThrow(/day\|week\|month\|all/);
  });
});

describe('feature caps', () => {
  it('set/get/list roundtrip', () => {
    const t = fresh();
    expect(t.getFeatureCap('chat')).toBeUndefined();
    t.setFeatureCap('chat', 5000);
    expect(t.getFeatureCap('chat')).toBe(5000);
    t.setFeatureCap('chat', 6000);
    expect(t.getFeatureCap('chat')).toBe(6000);
    expect(t.listFeatureCaps()).toEqual([{ feature: 'chat', monthlyCapCents: 6000 }]);
    expect(() => t.setFeatureCap('chat', -1)).toThrow();
  });

  it('capStatus reports capExceeded only when spend passes the cap', () => {
    const t = fresh();
    // No cap → never exceeded.
    t.record({ feature: 'chat', step: 'a', inputTokens: 0, outputTokens: 0, costCents: 999 });
    const noCap = t.capStatus('chat');
    expect(noCap.capCents).toBeNull();
    expect(noCap.capExceeded).toBe(false);
    expect(noCap.spentCents).toBe(999);

    t.setFeatureCap('chat', 1000);
    expect(t.capStatus('chat').capExceeded).toBe(false); // 999 < 1000

    t.record({ feature: 'chat', step: 'a', inputTokens: 0, outputTokens: 0, costCents: 2 });
    const over = t.capStatus('chat');
    expect(over.capExceeded).toBe(true);
    expect(over.spentCents).toBe(1001);
    expect(over.capCents).toBe(1000);
    expect(over.periodStart).toBeLessThan(over.periodEnd);

    // Other features are unaffected.
    expect(t.capStatus('workflows').capExceeded).toBe(false);
    expect(t.allCapStatuses().length).toBe(1);
    expect(t.allCapStatuses()[0].capExceeded).toBe(true);
  });
});

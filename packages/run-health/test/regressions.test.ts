// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { detectRegressions } from '../src/regressions.js';
import type { MetricSample } from '../src/types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

/** Build N samples spread across a [start, end] window. */
function samples(
  scopeKind: 'workflow' | 'bot',
  scopeId: string,
  n: number,
  start: number,
  end: number,
  mk: (i: number) => Partial<MetricSample>,
): MetricSample[] {
  const out: MetricSample[] = [];
  for (let i = 0; i < n; i++) {
    // Spread strictly inside (start, end) so boundary samples do not leak
    // into the adjacent comparison window.
    const ts = start + ((end - start) * (i + 0.5)) / n;
    out.push({
      scopeKind,
      scopeId,
      ts,
      latencyMs: 1000,
      errored: false,
      ...mk(i),
    });
  }
  return out;
}

describe('detectRegressions', () => {
  it('flags p50 latency regression >30% with enough samples', () => {
    const baseline = samples('workflow', 'wf-a', 12, NOW - 14 * DAY, NOW - 7 * DAY, () => ({ latencyMs: 1000 }));
    const current = samples('workflow', 'wf-a', 12, NOW - 7 * DAY, NOW, () => ({ latencyMs: 1500 }));
    const alerts = detectRegressions([...baseline, ...current], { now: NOW });
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.id).toBe('workflow:wf-a:latency-p50');
    expect(a.metric).toBe('latency-p50');
    expect(a.changePct).toBeGreaterThan(30);
    expect(a.baselineSamples).toBe(12);
    expect(a.currentSamples).toBe(12);
  });

  it('no alert when degradation is under the threshold', () => {
    const baseline = samples('workflow', 'wf-a', 12, NOW - 14 * DAY, NOW - 7 * DAY, () => ({ latencyMs: 1000 }));
    const current = samples('workflow', 'wf-a', 12, NOW - 7 * DAY, NOW, () => ({ latencyMs: 1200 }));
    expect(detectRegressions([...baseline, ...current], { now: NOW })).toHaveLength(0);
  });

  it('no alert on improvement', () => {
    const baseline = samples('workflow', 'wf-a', 12, NOW - 14 * DAY, NOW - 7 * DAY, () => ({ latencyMs: 1500 }));
    const current = samples('workflow', 'wf-a', 12, NOW - 7 * DAY, NOW, () => ({ latencyMs: 1000 }));
    expect(detectRegressions([...baseline, ...current], { now: NOW })).toHaveLength(0);
  });

  it('respects the minimum-sample guard in each window', () => {
    const baseline = samples('workflow', 'wf-a', 12, NOW - 14 * DAY, NOW - 7 * DAY, () => ({ latencyMs: 1000 }));
    const current = samples('workflow', 'wf-a', 5, NOW - 7 * DAY, NOW, () => ({ latencyMs: 5000 }));
    expect(detectRegressions([...baseline, ...current], { now: NOW, minSamples: 10 })).toHaveLength(0);
    expect(detectRegressions([...baseline, ...current], { now: NOW, minSamples: 5 })).toHaveLength(1);
  });

  it('flags error-rate regression with absolute guard', () => {
    // baseline 5% errors → current 15% errors: +200% relative, +10pp absolute
    const baseline = samples('bot', 'bot-x', 20, NOW - 14 * DAY, NOW - 7 * DAY, (i) => ({ errored: i === 0 }));
    const current = samples('bot', 'bot-x', 20, NOW - 7 * DAY, NOW, (i) => ({ errored: i < 3 }));
    const alerts = detectRegressions([...baseline, ...current], { now: NOW });
    const err = alerts.find((a) => a.metric === 'error-rate')!;
    expect(err).toBeDefined();
    expect(err.scopeId).toBe('bot-x');
  });

  it('tiny absolute error movement does not alert despite large relative change', () => {
    // 1000 samples: 1 error → 3 errors (+200% relative, +0.2pp absolute)
    const baseline = samples('bot', 'bot-y', 1000, NOW - 14 * DAY, NOW - 7 * DAY, (i) => ({ errored: i === 0 }));
    const current = samples('bot', 'bot-y', 1000, NOW - 7 * DAY, NOW, (i) => ({ errored: i < 3 }));
    const alerts = detectRegressions([...baseline, ...current], { now: NOW });
    expect(alerts.find((a) => a.metric === 'error-rate')).toBeUndefined();
  });

  it('flags cost-per-run regression', () => {
    const baseline = samples('bot', 'bot-c', 12, NOW - 14 * DAY, NOW - 7 * DAY, () => ({ costUsd: 0.01 }));
    const current = samples('bot', 'bot-c', 12, NOW - 7 * DAY, NOW, () => ({ costUsd: 0.02 }));
    const alerts = detectRegressions([...baseline, ...current], { now: NOW });
    const cost = alerts.find((a) => a.metric === 'cost-per-run')!;
    expect(cost).toBeDefined();
    expect(cost.changePct).toBeCloseTo(100, 5);
  });

  it('scopes are independent: only the regressed scope alerts', () => {
    const mk = (id: string, cur: number) => [
      ...samples('workflow', id, 12, NOW - 14 * DAY, NOW - 7 * DAY, () => ({ latencyMs: 1000 })),
      ...samples('workflow', id, 12, NOW - 7 * DAY, NOW, () => ({ latencyMs: cur })),
    ];
    const alerts = detectRegressions([...mk('wf-ok', 1100), ...mk('wf-bad', 2000)], { now: NOW });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].scopeId).toBe('wf-bad');
  });

  it('sorts worst-first', () => {
    const mk = (id: string, cur: number) => [
      ...samples('workflow', id, 12, NOW - 14 * DAY, NOW - 7 * DAY, () => ({ latencyMs: 1000 })),
      ...samples('workflow', id, 12, NOW - 7 * DAY, NOW, () => ({ latencyMs: cur })),
    ];
    const alerts = detectRegressions([...mk('wf-mild', 1400), ...mk('wf-bad', 3000)], { now: NOW });
    expect(alerts.map((a) => a.scopeId)).toEqual(['wf-bad', 'wf-mild']);
  });
});

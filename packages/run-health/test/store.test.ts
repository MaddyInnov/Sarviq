// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunHealthStore } from '../src/store.js';
import type { RunHealth } from '../src/types.js';

const stores: RunHealthStore[] = [];
function freshStore(): RunHealthStore {
  const dir = mkdtempSync(join(tmpdir(), 'run-health-'));
  const s = new RunHealthStore(join(dir, 'health.db'));
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

const health = (over: Partial<RunHealth> = {}): RunHealth => ({
  runId: 'run-1',
  workflowId: 'wf-1',
  score: 'needs-work',
  findings: [{ signal: 'latency', severity: 'warning', title: 't', detail: 'd', fix: 'f' }],
  latencyMs: 5000,
  failedNodes: 0,
  generatedAt: 1_700_000_000_000,
  ...over,
});

describe('RunHealthStore', () => {
  it('round-trips run health scores', () => {
    const s = freshStore();
    expect(s.getRunHealth('run-1')).toBeUndefined();
    s.saveRunHealth(health());
    const got = s.getRunHealth('run-1')!;
    expect(got.score).toBe('needs-work');
    expect(got.findings).toHaveLength(1);
    expect(got.latencyMs).toBe(5000);
    // upsert overwrites
    s.saveRunHealth(health({ score: 'good', findings: [] }));
    expect(s.getRunHealth('run-1')!.score).toBe('good');
  });

  it('lists run health newest-first, filterable by workflow', () => {
    const s = freshStore();
    s.saveRunHealth(health({ runId: 'r1', generatedAt: 100 }));
    s.saveRunHealth(health({ runId: 'r2', workflowId: 'wf-2', generatedAt: 200 }));
    s.saveRunHealth(health({ runId: 'r3', generatedAt: 300 }));
    expect(s.listRunHealth().map((h) => h.runId)).toEqual(['r3', 'r2', 'r1']);
    expect(s.listRunHealth('wf-1').map((h) => h.runId)).toEqual(['r3', 'r1']);
  });

  it('records and queries metric samples by scope and window', () => {
    const s = freshStore();
    s.recordMetric({ scopeKind: 'workflow', scopeId: 'wf-1', ts: 1000, latencyMs: 500, errored: false, runId: 'r1' });
    s.recordMetric({ scopeKind: 'workflow', scopeId: 'wf-1', ts: 2000, latencyMs: 700, errored: true, costUsd: 0.02, tokens: 1500 });
    s.recordMetric({ scopeKind: 'bot', scopeId: 'b1', ts: 1500, latencyMs: 300, errored: false });
    const wf = s.queryMetrics('workflow', 'wf-1', 0, 3000);
    expect(wf).toHaveLength(2);
    expect(wf[0].latencyMs).toBe(500);
    expect(wf[1].errored).toBe(true);
    expect(wf[1].costUsd).toBe(0.02);
    expect(wf[1].tokens).toBe(1500);
    expect(s.queryMetrics('workflow', 'wf-1', 0, 1500)).toHaveLength(1);
    expect(s.listScopes()).toEqual([
      { scopeKind: 'bot', scopeId: 'b1' },
      { scopeKind: 'workflow', scopeId: 'wf-1' },
    ]);
  });

  it('computes scope baselines (p50 latency / tokens)', () => {
    const s = freshStore();
    for (const [ts, lat, tok] of [[1000, 100, 1000], [2000, 200, 2000], [3000, 300, 3000]] as const) {
      s.recordMetric({ scopeKind: 'bot', scopeId: 'b1', ts, latencyMs: lat, errored: false, tokens: tok });
    }
    const b = s.scopeBaselines('bot', 'b1', 0);
    expect(b.p50LatencyMs).toBe(200);
    expect(b.p50Tokens).toBe(2000);
    expect(s.scopeBaselines('bot', 'unknown', 0)).toEqual({});
  });

  it('round-trips turn health', () => {
    const s = freshStore();
    s.saveTurnHealth({ botId: 'b1', sessionId: 's1', score: 'poor', findings: [], generatedAt: 500 });
    s.saveTurnHealth({ botId: 'b1', score: 'good', findings: [], generatedAt: 600 });
    const list = s.listTurnHealth('b1');
    expect(list.map((t) => t.score)).toEqual(['good', 'poor']);
    expect(list[0].sessionId).toBeUndefined();
  });
});

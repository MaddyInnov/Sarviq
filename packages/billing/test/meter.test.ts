// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageMeter } from '../src/meter.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'bill-meter-test-')), 'billing.db');
}

describe('UsageMeter', () => {
  it('records token usage per session/bot', () => {
    const meter = new UsageMeter(tmpDb());
    meter.recordTokens('s1', 'coder', { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    meter.recordTokens('s1', 'coder', { promptTokens: 200, completionTokens: 100, totalTokens: 300 });
    const s = meter.summary({ botId: 'coder' });
    expect(s.sessions).toBe(1);
    expect(s.promptTokens).toBe(300);
    expect(s.completionTokens).toBe(150);
    expect(s.totalTokens).toBe(450);
    meter.close();
  });

  it('records workflow runs and sandbox minutes', () => {
    const meter = new UsageMeter(tmpDb());
    meter.recordWorkflowRun('run_1', 'nightly-digest', 'helper');
    meter.recordWorkflowRun('run_2', 'nightly-digest', 'helper');
    meter.recordSandboxMinutes('s1', 'coder', 2.5);
    const s = meter.summary();
    expect(s.workflowRuns).toBe(2);
    expect(s.sandboxMinutes).toBeCloseTo(2.5, 5);
    meter.close();
  });

  it('lists events with filters', () => {
    const meter = new UsageMeter(tmpDb());
    meter.recordTokens('s1', 'coder', { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    meter.recordTokens('s2', 'scout', { promptTokens: 20, completionTokens: 5, totalTokens: 25 });
    expect(meter.list({ botId: 'coder' }).length).toBe(1);
    expect(meter.list({ sessionId: 's2' }).length).toBe(1);
    expect(meter.list().length).toBe(2);
    expect(meter.list({ limit: 1 }).length).toBe(1);
    meter.close();
  });

  it('filters summary by time window', () => {
    const meter = new UsageMeter(tmpDb());
    meter.recordTokens('s1', 'coder', { promptTokens: 100, completionTokens: 0, totalTokens: 100 });
    const s = meter.summary({ since: Date.now() + 10_000 });
    expect(s.totalTokens).toBe(0);
    meter.close();
  });

  it('rejects invalid usage values', () => {
    const meter = new UsageMeter(tmpDb());
    expect(() =>
      meter.recordTokens('s', 'b', { promptTokens: -1, completionTokens: 0, totalTokens: 0 }),
    ).toThrow();
    expect(() =>
      meter.recordTokens('s', 'b', { promptTokens: 1.5, completionTokens: 0, totalTokens: 0 }),
    ).toThrow();
    expect(() => meter.recordSandboxMinutes('s', 'b', -2)).toThrow();
    meter.close();
  });
});

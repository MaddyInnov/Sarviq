// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { TelemetryCollector } from '../src/telemetry.js';
import type { TelemetryGuard } from '../src/telemetry.js';

const usage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };

function completedRun(
  collector: TelemetryCollector,
  opts: { botId?: string; kind?: 'bot-turn' | 'workflow-run'; workflowId?: string; fail?: boolean; retries?: number } = {},
): string {
  const kind = opts.kind ?? 'bot-turn';
  const id = collector.beginRun({
    kind,
    // Workflow runs aggregate under workflow:<id>; only bot turns default a bot.
    botId: kind === 'bot-turn' ? (opts.botId ?? 'bot-a') : opts.botId,
    workflowId: opts.workflowId,
    sessionId: 'sess-1',
  })!;
  expect(id).not.toBeNull();
  const step = collector.startStep(id, 'llm:model', 'llm')!;
  if (opts.retries) for (let i = 0; i < opts.retries; i++) collector.noteRetry(id);
  step.end({ ok: !opts.fail, errorKind: opts.fail ? 'Error' : undefined });
  collector.endRun(id, {
    status: opts.fail ? 'error' : 'ok',
    usage,
    providerId: 'groq',
    model: 'llama-3.3-70b-versatile',
    iterations: 2,
  });
  return id;
}

describe('TelemetryCollector', () => {
  it('records a run with steps, tokens, and a finite cost', () => {
    const c = new TelemetryCollector();
    const id = completedRun(c);
    const run = c.getRun(id)!;
    expect(run.kind).toBe('bot-turn');
    expect(run.botId).toBe('bot-a');
    expect(run.status).toBe('ok');
    expect(run.totalTokens).toBe(1500);
    expect(run.promptTokens).toBe(1000);
    expect(Number.isFinite(run.costUsd)).toBe(true);
    expect(run.costUsd).toBeGreaterThanOrEqual(0);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]!.ok).toBe(true);
    expect(run.steps[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.iterations).toBe(2);
  });

  it('counts failed steps and error runs', () => {
    const c = new TelemetryCollector();
    const okId = completedRun(c);
    const failId = completedRun(c, { fail: true });
    expect(c.getRun(okId)!.errors).toBe(0);
    // One failed step + the error endRun status each increment the counter.
    expect(c.getRun(failId)!.errors).toBeGreaterThanOrEqual(1);
    const s = c.summary();
    expect(s.windowRuns).toBe(2);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBe(0.5);
  });

  it('tracks retries and retry rate', () => {
    const c = new TelemetryCollector();
    completedRun(c);
    completedRun(c, { retries: 3 });
    const s = c.summary();
    expect(s.retries).toBe(3);
    expect(s.retryRate).toBe(0.5);
  });

  it('computes latency percentiles over completed runs', () => {
    const c = new TelemetryCollector();
    for (let i = 0; i < 4; i++) completedRun(c);
    const s = c.summary();
    expect(s.p50LatencyMs).toBeGreaterThanOrEqual(0);
    expect(s.p95LatencyMs).toBeGreaterThanOrEqual(s.p50LatencyMs);
    expect(s.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(s.byKind['bot-turn'].runs).toBe(4);
  });

  it('evicts the oldest completed runs past maxRuns, never in-flight ones', () => {
    const c = new TelemetryCollector({ maxRuns: 3 });
    const ids = [completedRun(c), completedRun(c), completedRun(c)];
    const inflight = c.beginRun({ kind: 'bot-turn', botId: 'bot-a' })!;
    // In-flight begin evicted ids[0]; the 4th completed run evicts ids[1].
    const fourth = completedRun(c);
    expect(c.getRun(ids[0]!)).toBeNull();
    expect(c.getRun(ids[1]!)).toBeNull();
    expect(c.getRun(ids[2]!)).not.toBeNull();
    expect(c.getRun(fourth)).not.toBeNull();
    expect(c.getRun(inflight)).not.toBeNull();
    // Summary counts only completed runs (ids[2] + fourth).
    expect(c.summary().windowRuns).toBe(2);
    expect(c.summary().inflight).toBe(1);
  });

  it('reuses an in-flight record for an explicit id (workflow resume)', () => {
    const c = new TelemetryCollector();
    const first = c.beginRun({ id: 'wf-1', kind: 'workflow-run', workflowId: 'wf' })!;
    const second = c.beginRun({ id: 'wf-1', kind: 'workflow-run', workflowId: 'wf' })!;
    expect(second).toBe(first);
    expect(c.listRuns(10)).toHaveLength(1);
  });

  it('lists newest-first with botId/kind filters', () => {
    const c = new TelemetryCollector();
    completedRun(c, { botId: 'bot-a' });
    completedRun(c, { botId: 'bot-b' });
    completedRun(c, { kind: 'workflow-run', workflowId: 'wf-1' });
    const all = c.listRuns(10);
    expect(all).toHaveLength(3);
    expect(c.listRuns({ botId: 'bot-a' })).toHaveLength(1);
    expect(c.listRuns({ kind: 'workflow-run' })).toHaveLength(1);
    expect(c.listRuns(2)).toHaveLength(2);
    expect(c.getRun('nope')).toBeNull();
  });

  it('aggregates per-bot summaries (workflow runs key as workflow:<id>)', () => {
    const c = new TelemetryCollector();
    completedRun(c, { botId: 'bot-a' });
    completedRun(c, { botId: 'bot-a', fail: true });
    completedRun(c, { kind: 'workflow-run', workflowId: 'wf-1' });
    const bots = c.botSummaries();
    const a = bots.find((b) => b.id === 'bot-a')!;
    expect(a.runs).toBe(2);
    expect(a.errors).toBe(1);
    expect(a.errorRate).toBe(0.5);
    expect(a.totalTokens).toBe(3000);
    expect(bots.find((b) => b.id === 'workflow:wf-1')!.runs).toBe(1);
  });

  it('ignores steps/retries/endRun for unknown or finished runs', () => {
    const c = new TelemetryCollector();
    expect(c.startStep('nope', 'x', 'llm')).toBeNull();
    c.noteRetry('nope');
    c.endRun('nope', { status: 'ok' });
    const id = completedRun(c);
    expect(c.startStep(id, 'late', 'llm')).toBeNull(); // already ended
  });

  it('drops the run when the ingestion guard refuses, with a warning', () => {
    const warn = vi.fn();
    const guard: TelemetryGuard = () => ({ accepted: false, reason: 'carries headers', droppedFields: ['headers'] });
    const c = new TelemetryCollector({ guard, warn });
    expect(c.beginRun({ kind: 'bot-turn', botId: 'bot-a' })).toBeNull();
    expect(c.listRuns(10)).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/refused/);
  });

  it('stores the guard-sanitized (name-normalized) metadata', () => {
    const guard: TelemetryGuard = (payload) => ({
      accepted: true,
      sanitized: { ...payload, route: '/api/bots/:id/chat' },
    });
    const c = new TelemetryCollector({ guard });
    const id = c.beginRun({ kind: 'bot-turn', botId: 'bot-a', route: '/api/bots/12345/chat' })!;
    expect(c.getRun(id)!.route).toBe('/api/bots/:id/chat');
  });

  it('fail-closes when the guard throws', () => {
    const warn = vi.fn();
    const guard: TelemetryGuard = () => {
      throw new Error('boom');
    };
    const c = new TelemetryCollector({ guard, warn });
    expect(c.beginRun({ kind: 'bot-turn', botId: 'bot-a' })).toBeNull();
    expect(c.listRuns(10)).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('endRun never throws and tolerates unknown pricing', () => {
    const c = new TelemetryCollector();
    const id = c.beginRun({ kind: 'bot-turn', botId: 'bot-a' })!;
    expect(() =>
      c.endRun(id, { status: 'ok', usage, providerId: 'nope', model: 'nope' }),
    ).not.toThrow();
    expect(c.getRun(id)!.costUsd).toBe(0);
  });
});

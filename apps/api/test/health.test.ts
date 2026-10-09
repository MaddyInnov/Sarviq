// SPDX-License-Identifier: Apache-2.0
// Route-level tests for the run-health endpoints (features #2/#5). Localhost
// HTTP + temp SQLite files only — no external network.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowStore } from '@mvp/workflows';
import type { WorkflowRun, WorkflowRunner } from '@mvp/workflows';
import { RunHealthStore } from '@mvp/run-health';
import type { RunHealth } from '@mvp/run-health';
import { registerHealthRoutes } from '../src/health-routes.js';

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const failedRun: WorkflowRun = {
  id: 'run-fail-1',
  workflowId: 'wf-1',
  status: 'failed',
  nodeStates: {
    trigger: { status: 'succeeded', startedAt: NOW, endedAt: NOW + 100, output: null, attempts: 1 },
    fetch: {
      status: 'failed',
      startedAt: NOW + 100,
      endedAt: NOW + 30_100,
      error: 'request timed out after 30s',
      attempts: 3,
    },
  },
  input: null,
  createdAt: NOW,
  updatedAt: NOW + 31_000,
};

describe('health routes', () => {
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let runHealth: RunHealthStore;
  let wfStore: WorkflowStore;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'health-routes-'));
    wfStore = new WorkflowStore(join(dir, 'workflows.db'));
    wfStore.insertRun(failedRun);
    runHealth = new RunHealthStore(join(dir, 'run-health.db'));

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerHealthRoutes(router, {
      workflowRunner: { getRun: (id: string) => wfStore.getRun(id) } as unknown as WorkflowRunner,
      runHealth,
    });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      (server as unknown as { close(cb: () => void): void }).close(() => resolve()),
    );
    server = null;
    runHealth.close();
    wfStore.close();
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('scores a failed run as poor with a written diagnosis + fix, then caches it', async () => {
    const first = await api('GET', '/health/runs/run-fail-1');
    expect(first.status).toBe(200);
    const health = first.json as RunHealth;
    expect(health.score).toBe('poor');
    expect(health.runId).toBe('run-fail-1');
    const timeout = health.findings.find((f) => f.title === 'Step hit a timeout');
    expect(timeout).toBeDefined();
    expect(timeout!.fix).toMatch(/backoff/i);
    expect(timeout!.nodeId).toBe('fetch');
    const retry = health.findings.find((f) => f.signal === 'retries');
    expect(retry?.title).toContain('3×');

    // Score persisted with the run record; metric sample recorded for
    // regression history.
    expect(runHealth.getRunHealth('run-fail-1')?.score).toBe('poor');
    expect(runHealth.queryMetrics('workflow', 'wf-1', 0, Date.now())).toHaveLength(1);

    const second = await api('GET', '/health/runs/run-fail-1');
    expect((second.json as RunHealth).generatedAt).toBe(health.generatedAt);
  });

  it('404s on unknown runs', async () => {
    expect((await api('GET', '/health/runs/nope')).status).toBe(404);
  });

  it('scores bot turns, validates input, and lists turn health', async () => {
    const bad = await api('POST', '/health/turns', { botId: 'b1' });
    expect(bad.status).toBe(400);
    const missingBot = await api('POST', '/health/turns', {
      latencyMs: 1000,
      totalTokens: 100,
      errored: false,
    });
    expect(missingBot.status).toBe(400);

    const ok = await api('POST', '/health/turns', {
      botId: 'b1',
      sessionId: 's1',
      latencyMs: 45_000,
      totalTokens: 6000,
      errored: true,
      errorMessage: '429 rate limit exceeded',
      toolRetries: 4,
    });
    expect(ok.status).toBe(200);
    const turn = ok.json as { score: string; findings: { title: string; fix: string }[] };
    expect(turn.score).toBe('poor');
    expect(turn.findings.some((f) => /rate limit/i.test(f.title))).toBe(true);

    const list = await api('GET', '/health/turns?botId=b1');
    expect(list.status).toBe(200);
    expect((list.json as unknown[]).length).toBe(1);
    // Bot metric sample feeds regression detection.
    expect(runHealth.queryMetrics('bot', 'b1', 0, Date.now())).toHaveLength(1);
  });

  it('detects a latency regression across the 7-day windows', async () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      runHealth.recordMetric({
        scopeKind: 'workflow',
        scopeId: 'wf-9',
        ts: now - 13 * DAY + i * DAY * 0.4,
        latencyMs: 1000,
        errored: false,
      });
      runHealth.recordMetric({
        scopeKind: 'workflow',
        scopeId: 'wf-9',
        ts: now - 6 * DAY + i * DAY * 0.4,
        latencyMs: 1600,
        errored: false,
      });
    }
    const res = await api('GET', '/health/regressions');
    expect(res.status).toBe(200);
    const payload = res.json as {
      windowDays: number;
      thresholdPct: number;
      minSamples: number;
      regressions: { id: string; changePct: number; baselineSamples: number; currentSamples: number }[];
    };
    expect(payload.windowDays).toBe(7);
    expect(payload.thresholdPct).toBe(30);
    expect(payload.minSamples).toBe(10);
    const alert = payload.regressions.find((r) => r.id === 'workflow:wf-9:latency-p50');
    expect(alert).toBeDefined();
    expect(alert!.changePct).toBeGreaterThan(30);
    expect(alert!.baselineSamples).toBe(12);
    expect(alert!.currentSamples).toBe(12);
  });

  it('returns no regressions with insufficient samples', async () => {
    const res = await api('GET', '/health/regressions');
    expect(res.status).toBe(200);
    expect((res.json as { regressions: unknown[] }).regressions).toEqual([]);
  });
});

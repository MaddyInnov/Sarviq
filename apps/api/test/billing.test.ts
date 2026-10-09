// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BillingLedger, CostTracker, MockBillingProvider, UsageMeter } from '@mvp/billing';
import { registerBillingRoutes } from '../src/billing.js';

describe('billing router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'billing-routes-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerBillingRoutes(router, {
      dataDir: dir,
      meter: new UsageMeter(join(dir, 'billing.db')),
      ledger: new BillingLedger(join(dir, 'billing.db')),
      provider: new MockBillingProvider(),
      costTracker: new CostTracker(join(dir, 'billing.db')),
    });
    app.use('/api/billing', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/billing`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path = '', body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('records usage events and reports summaries', async () => {
    const r = await api('POST', '/usage', {
      kind: 'tokens',
      sessionId: 's1',
      botId: 'coder',
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    });
    expect(r.status).toBe(201);

    await api('POST', '/usage', { kind: 'workflow', workflowId: 'nightly-digest', runId: 'run_1' });
    await api('POST', '/usage', { kind: 'sandbox', sessionId: 's1', botId: 'coder', minutes: 3 });

    const summary = (await api('GET', '/usage')).json as {
      totalTokens: number;
      workflowRuns: number;
      sandboxMinutes: number;
    };
    expect(summary.totalTokens).toBe(1500);
    expect(summary.workflowRuns).toBe(1);
    expect(summary.sandboxMinutes).toBe(3);

    const byBot = (await api('GET', '/usage?botId=coder')).json as { totalTokens: number };
    expect(byBot.totalTokens).toBe(1500);

    expect((await api('POST', '/usage', { kind: 'tokens' })).status).toBe(400);
    expect((await api('POST', '/usage', { kind: 'bogus' })).status).toBe(400);
  });

  it('quotes usage cost in integer cents', async () => {
    const cost = (await api('GET', '/usage/cost')).json as {
      costCents: number;
      priceConfig: Record<string, number>;
    };
    expect(Number.isInteger(cost.costCents)).toBe(true);
    expect(cost.priceConfig.inputPer1MCents).toBeGreaterThan(0);
  });

  it('runs the mock billing lifecycle end to end', async () => {
    const cus = (await api('POST', '/customers', { email: 'founder@example.com' })).json as { id: string };
    expect(cus.id.startsWith('cus_')).toBe(true);
    expect((await api('POST', '/customers', { email: 'bad' })).status).toBe(400);

    const inv = (
      await api('POST', '/invoices', {
        customerId: cus.id,
        lines: [{ description: 'token usage', amountCents: 250 }],
      })
    ).json as { id: string; status: string; totalCents: number };
    expect(inv.status).toBe('draft');
    expect(inv.totalCents).toBe(250);

    const open = (await api('POST', `/invoices/${inv.id}/finalize`)).json as { status: string };
    expect(open.status).toBe('open');

    const paid = (await api('POST', `/invoices/${inv.id}/pay`)).json as {
      status: string;
      mock: boolean;
    };
    expect(paid.status).toBe('paid');
    expect(paid.mock).toBe(true);

    // The payment is mirrored in the persistent ledger.
    const ledger = (await api('GET', '/ledger')).json as { status: string; totalCents: number }[];
    expect(ledger.some((l) => l.status === 'paid' && l.totalCents === 250)).toBe(true);
    const one = await api('GET', `/ledger/${inv.id}`);
    expect(one.status).toBe(200);
    expect((await api('GET', '/invoices/nope')).status).toBe(404);
  });

  it('mocks payment intents', async () => {
    const cus = (await api('POST', '/customers', { email: 'founder@example.com' })).json as { id: string };
    const pi = (
      await api('POST', '/payment-intents', { customerId: cus.id, amountCents: 999 })
    ).json as { id: string; status: string };
    expect(pi.id.startsWith('pi_')).toBe(true);
    const confirmed = (await api('POST', `/payment-intents/${pi.id}/confirm`)).json as {
      status: string;
      mock: boolean;
    };
    expect(confirmed.status).toBe('succeeded');
    expect(confirmed.mock).toBe(true);
    expect((await api('GET', '/payment-intents/nope')).status).toBe(404);
  });
});

describe('cost dashboard', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'billing-cost-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerBillingRoutes(router, {
      dataDir: dir,
      meter: new UsageMeter(join(dir, 'billing.db')),
      ledger: new BillingLedger(join(dir, 'billing.db')),
      provider: new MockBillingProvider(),
      costTracker: new CostTracker(join(dir, 'billing.db')),
    });
    app.use('/api/billing', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/billing`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path = '', body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('records cost events and serves the breakdown', async () => {
    const r1 = await api('POST', '/usage/cost-events', {
      feature: 'chat',
      step: 'provider.chat',
      model: 'llama-3.3-70b',
      inputTokens: 1000,
      outputTokens: 500,
      costCents: 42,
    });
    expect(r1.status).toBe(201);
    expect(r1.json.feature).toBe('chat');

    await api('POST', '/usage/cost-events', {
      feature: 'workflows',
      step: 'run',
      inputTokens: 2000,
      outputTokens: 0,
      costCents: 100,
    });

    const b = await api('GET', '/usage/breakdown?period=all');
    expect(b.status).toBe(200);
    expect(b.json.totals).toMatchObject({ events: 2, costCents: 142 });
    expect(b.json.byFeature.map((f: any) => f.feature).sort()).toEqual(['chat', 'workflows']);
    expect(b.json.byStep.length).toBe(2);

    const bad = await api('GET', '/usage/breakdown?period=fortnight');
    expect(bad.status).toBe(400);

    const invalid = await api('POST', '/usage/cost-events', { feature: 'x' });
    expect(invalid.status).toBe(400);
  });

  it('enforces monthly feature caps with a capExceeded signal', async () => {
    const set = await api('PUT', '/usage/caps/chat', { monthlyCapCents: 50 });
    expect(set.status).toBe(200);
    expect(set.json.capCents).toBe(50);
    expect(set.json.capExceeded).toBe(false);

    await api('POST', '/usage/cost-events', {
      feature: 'chat',
      step: 'provider.chat',
      inputTokens: 100,
      outputTokens: 0,
      costCents: 60,
    });

    const caps = await api('GET', '/usage/caps');
    expect(caps.status).toBe(200);
    const chat = (caps.json as any[]).find((c) => c.feature === 'chat');
    expect(chat.capExceeded).toBe(true);
    expect(chat.spentCents).toBe(60);

    const bad = await api('PUT', '/usage/caps/chat', {});
    expect(bad.status).toBe(400);
  });
});

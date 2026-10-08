// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowRunner, WorkflowRun } from '@mvp/workflows';
import { TriggerStore } from '@mvp/workflows/dist/triggers.js';
import { createWebhookRouter } from '../src/webhooks.js';

const SECRET = 'test-secret-12345678';

interface StartRunCall {
  workflowId: string;
  input: unknown;
  opts?: { idempotencyKey?: string };
}

describe('webhook router', () => {
  let dir: string;
  let triggerStore: TriggerStore;
  let calls: StartRunCall[];
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  const fakeRunner = {
    startRun: async (workflowId: string, input: unknown, opts?: { idempotencyKey?: string }) => {
      calls.push({ workflowId, input, opts });
      return { id: `run-${calls.length}` } as WorkflowRun;
    },
  } as unknown as WorkflowRunner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'webhooks-'));
    triggerStore = new TriggerStore(join(dir, 'triggers.db'));
    calls = [];
    const app = express();
    app.use(express.json());
    app.use('/webhooks', createWebhookRouter({ runner: fakeRunner, triggerStore }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
    triggerStore.close();
  });

  function post(id: string, headers: Record<string, string> = {}, body: unknown = { ping: 1 }): Promise<Response> {
    return fetch(`${baseUrl}/webhooks/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('starts a run and returns runId on valid secret', async () => {
    const t = triggerStore.create({ workflowId: 'wf-1', kind: 'webhook', secret: SECRET });
    const res = await post(t.id, { 'x-webhook-secret': SECRET });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { runId: string };
    expect(json.runId).toBe('run-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].workflowId).toBe('wf-1');
    expect(calls[0].input).toMatchObject({ trigger: 'webhook', triggerId: t.id });
  });

  it('passes an idempotency key through when the sender provides one', async () => {
    const t = triggerStore.create({ workflowId: 'wf-1', kind: 'webhook', secret: SECRET });
    const res = await post(t.id, { 'x-webhook-secret': SECRET, 'x-idempotency-key': 'sender-key-1' });
    expect(res.status).toBe(200);
    expect(calls[0].opts).toMatchObject({ idempotencyKey: 'sender-key-1' });
  });

  it('returns 401 on wrong or missing secret and starts nothing', async () => {
    const t = triggerStore.create({ workflowId: 'wf-1', kind: 'webhook', secret: SECRET });
    const wrong = await post(t.id, { 'x-webhook-secret': 'wrong-secret-value!!' });
    expect(wrong.status).toBe(401);
    const missing = await post(t.id);
    expect(missing.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('returns 404 for unknown, disabled, or non-webhook triggers', async () => {
    expect((await post('does-not-exist', { 'x-webhook-secret': SECRET })).status).toBe(404);

    const disabled = triggerStore.create({ workflowId: 'wf-1', kind: 'webhook', secret: SECRET });
    triggerStore.setEnabled(disabled.id, false);
    expect((await post(disabled.id, { 'x-webhook-secret': SECRET })).status).toBe(404);

    const cron = triggerStore.create({ workflowId: 'wf-1', kind: 'cron', cron: '* * * * *' });
    expect((await post(cron.id, { 'x-webhook-secret': SECRET })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

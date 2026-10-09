// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/processing-rules-routes.ts: rule CRUD, firing, and
// the searchable firing log over HTTP. Temp data dirs only.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { registerProcessingRuleRoutes } from '../src/processing-rules-routes.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'proc-rules-api-'));
}

describe('processing rules router', () => {
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    const dir = freshDataDir();
    const governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerProcessingRuleRoutes(router, { dataDir: dir, governance });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('CRUD roundtrip with validation', async () => {
    const created = await api('POST', '/processing-rules', {
      name: 'tag outages',
      match: { textPattern: 'outage' },
      actions: [{ type: 'tag', params: { tag: 'urgent' } }],
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json.enabled).toBe(true);

    const got = await api('GET', `/processing-rules/${id}`);
    expect(got.status).toBe(200);
    expect(got.json.name).toBe('tag outages');

    const listed = await api('GET', '/processing-rules');
    expect((listed.json as unknown[]).length).toBe(1);

    const patched = await api('PATCH', `/processing-rules/${id}`, { enabled: false });
    expect(patched.json.enabled).toBe(false);

    const bad = await api('POST', '/processing-rules', { name: 'x', actions: [] });
    expect(bad.status).toBe(400);

    const del = await api('DELETE', `/processing-rules/${id}`);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });
    expect((await api('GET', `/processing-rules/${id}`)).status).toBe(404);
  });

  it('fires a rule and exposes the firing log with filters', async () => {
    const created = await api('POST', '/processing-rules', {
      name: 'route oncall',
      match: { kind: 'message' },
      actions: [
        { type: 'route', params: { destination: 'oncall' } },
        { type: 'egress', params: { target: 'https://hooks.example.com/x' } }, // skipped: no egress runner
      ],
    });
    const id = created.json.id as string;

    const fired = await api('POST', `/processing-rules/${id}/fire`, {
      item: { id: 'msg-1', kind: 'message', text: 'hello' },
    });
    expect(fired.status).toBe(200);
    expect(fired.json.matchedRuleIds).toEqual([id]);
    expect(fired.json.firings.map((f: any) => f.status)).toEqual(['success', 'skipped']);

    // Non-matching item → no firings.
    const missed = await api('POST', `/processing-rules/${id}/fire`, {
      item: { id: 'f-1', kind: 'file' },
    });
    expect(missed.json.firings).toEqual([]);

    const log = await api('GET', '/processing-rules/firing-log');
    expect((log.json as unknown[]).length).toBe(2);

    const byRule = await api('GET', `/processing-rules/firing-log?ruleId=${id}`);
    expect((byRule.json as unknown[]).length).toBe(2);

    const skipped = await api('GET', '/processing-rules/firing-log?status=skipped');
    expect((skipped.json as any[]).length).toBe(1);
    expect(skipped.json[0].reason).toMatch(/no egress runner/);

    const success = await api('GET', '/processing-rules/firing-log?status=success');
    expect((success.json as any[]).length).toBe(1);

    const future = await api('GET', `/processing-rules/firing-log?since=${Date.now() + 60_000}`);
    expect((future.json as unknown[]).length).toBe(0);

    const badFire = await api('POST', `/processing-rules/${id}/fire`, { item: { kind: 'message' } });
    expect(badFire.status).toBe(400);
    expect((await api('POST', '/processing-rules/nope/fire', { item: { id: 'x', kind: 'y' } })).status).toBe(404);
  });
});

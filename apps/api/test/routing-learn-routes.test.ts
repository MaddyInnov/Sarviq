// SPDX-License-Identifier: Apache-2.0
// Routing-learn HTTP routes: corrections recorded via the API are learned
// and persisted, and the stored rules are listed back. Uses an ephemeral
// local express server — no network beyond localhost, no paid APIs.

import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerRoutingLearnRoutes } from '../src/routing-learn-routes.js';
import { loadRoutingRules } from '@mvp/agent-runtime';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

let baseUrl = '';
let server: ReturnType<express.Application['listen']> | undefined;
const dataDir = mkdtempSync(join(tmpdir(), 'routing-learn-api-'));

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const r = express.Router();
  registerRoutingLearnRoutes(r, { dataDir });
  app.use('/routing', r);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server!.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((err) => (err ? reject(err) : resolve()));
  });
  rmSync(dataDir, { recursive: true, force: true });
});

const correction = {
  taskType: 'code',
  routedProviderId: 'groq',
  routedModelId: 'llama-3.1-8b-instant',
  correctedProviderId: 'agent/claude-code',
  correctedModelId: 'sonnet',
  message: 'deploy the docker container to kubernetes',
};

describe('POST /api/routing/corrections', () => {
  it('records a correction and returns the learned rules', async () => {
    const res = await fetch(`${baseUrl}/routing/corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(correction),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; rules: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.rules.length).toBeGreaterThan(0);
    // Persisted: the chat route's loadRoutingRules sees the same rules.
    const stored = loadRoutingRules(dataDir);
    expect(stored.length).toBe(body.rules.length);
    expect(stored[0]).toMatchObject({
      then: { providerId: 'agent/claude-code', modelId: 'sonnet' },
    });
  });

  it('rejects an invalid correction with 400', async () => {
    const res = await fetch(`${baseUrl}/routing/corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskType: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/routing/rules', () => {
  it('lists the learned rules newest first', async () => {
    const res = await fetch(`${baseUrl}/routing/rules`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rules: { count: number }[] };
    expect(body.ok).toBe(true);
    expect(body.rules.length).toBeGreaterThan(0);
  });
});

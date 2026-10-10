// SPDX-License-Identifier: Apache-2.0
// Prompt-override HTTP routes: stage listing reflects the real store, and
// refresh re-reads override files (hot-reload path). Uses a throwaway
// prompts dir — no network, no paid APIs.

import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PromptOverrideStore } from '@mvp/agent-runtime';
import { registerPromptRoutes } from '../src/prompts-routes.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

let baseUrl = '';
let server: ReturnType<express.Application['listen']> | undefined;
let store: PromptOverrideStore;
const promptsDir = mkdtempSync(join(tmpdir(), 'prompts-api-'));

beforeAll(async () => {
  mkdirSync(promptsDir, { recursive: true });
  store = new PromptOverrideStore({ dir: promptsDir });
  const app = express();
  app.use(express.json());
  const r = express.Router();
  registerPromptRoutes(r, { store });
  app.use('/api', r);
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
  rmSync(promptsDir, { recursive: true, force: true });
});

describe('GET /api/prompts', () => {
  it('lists known stages with their active source', async () => {
    const res = await fetch(`${baseUrl}/api/prompts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      stages: { stage: string; source: string }[];
      overrides: unknown[];
    };
    expect(body.ok).toBe(true);
    const byStage = new Map(body.stages.map((s) => [s.stage, s.source]));
    expect(byStage.get('summarizer')).toBe('builtin');
    expect(byStage.get('router')).toBe('builtin');
  });

  it('reports an override file as the active source for that stage', async () => {
    writeFileSync(join(promptsDir, 'summarizer.md'), 'Custom override prompt.');
    const res = await fetch(`${baseUrl}/api/prompts`);
    const body = (await res.json()) as {
      stages: { stage: string; source: string }[];
      overrides: { stage: string }[];
    };
    const byStage = new Map(body.stages.map((s) => [s.stage, s.source]));
    expect(byStage.get('summarizer')).toBe('override');
    expect(body.overrides.map((o) => o.stage)).toContain('summarizer');
  });
});

describe('POST /api/prompts/refresh', () => {
  it('forces a re-read when an override changed without an mtime bump (stale cache)', async () => {
    const file = join(promptsDir, 'router.md');
    // Pin the file mtime to a fixed past instant so the rewrite below is
    // invisible to the mtime-based hot-reload (stale cache on purpose).
    const pinned = new Date(Date.now() - 120_000);
    writeFileSync(file, 'Router prompt v1.');
    utimesSync(file, pinned, pinned);
    expect(store.resolve('router').text).toBe('Router prompt v1.');
    // Filesystem mtime granularity is platform-dependent (some CI runners
    // round-trip with sub-millisecond error), so assert closeness, not exact
    // equality — the test's intent is "mtime pinned ~2min in the past".
    expect(Math.abs(statSync(file).mtimeMs - pinned.getTime())).toBeLessThan(5);

    // Rewrite the override but keep the pinned mtime: the mtime check in
    // resolve() cannot see this change (stale cache).
    writeFileSync(file, 'Router prompt v2.');
    utimesSync(file, pinned, pinned);
    expect(store.resolve('router').text).toBe('Router prompt v1.');

    const refresh = await fetch(`${baseUrl}/api/prompts/refresh`, { method: 'POST' });
    expect(refresh.status).toBe(200);
    const after = (await refresh.json()) as {
      ok: boolean;
      stages: { stage: string; source: string }[];
    };
    expect(after.ok).toBe(true);
    // Cache invalidated → next resolve re-reads the file content.
    expect(store.resolve('router').text).toBe('Router prompt v2.');
    expect(new Map(after.stages.map((s) => [s.stage, s.source])).get('router')).toBe('override');
  });
});

// SPDX-License-Identifier: Apache-2.0
// Route tests for GET /api/entities/trace (coherence-lite entity tracing).
// Spins up express on an ephemeral port; fully offline.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TieredMemoryStore } from '@mvp/agent-runtime';
import { KnowledgeBaseStore, LocalEmbedder, ModuleDb } from '@mvp/muse-modules';
import { registerEntityTraceRoutes } from '../src/entities.js';

describe('GET /api/entities/trace', () => {
  let dir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any = null;
  let baseUrl = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'entities-routes-'));

    // Seed the knowledge base (same muse-modules.db file the route opens).
    const mdb = new ModuleDb(join(dir, 'muse-modules.db'));
    const kb = new KnowledgeBaseStore(mdb, new LocalEmbedder());
    await kb.addDocument({
      title: 'PostgreSQL pooling',
      fileName: 'pg.md',
      mimeType: 'text/markdown',
      text: 'PgBouncer is a lightweight connection pooler for PostgreSQL. Run it in transaction pooling mode.',
    });
    mdb.close();

    // Seed tiered memory for bot1.
    const memory = new TieredMemoryStore(dir);
    memory.storeAtom(
      'bot1',
      { fact: 'We run PgBouncer in transaction mode for the billing database.', entities: ['PgBouncer'], confidence: 0.9 },
      's1',
    );

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerEntityTraceRoutes(router, { dataDir: dir, memoryStore: memory });
    app.use('/api/entities', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/entities`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function api(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('traces an entity across KB + memory with an extractive summary', async () => {
    const { status, json } = await api('/trace?q=PgBouncer&botId=bot1');
    expect(status).toBe(200);
    expect(json.entity).toBe('PgBouncer');
    expect(json.summaryKind).toBe('extractive');
    expect(String(json.summary)).toMatch(/extractive/i);
    const counts = json.counts as { knowledgeBase: number; memory: number };
    expect(counts.knowledgeBase).toBeGreaterThanOrEqual(1);
    expect(counts.memory).toBeGreaterThanOrEqual(1);
    const matches = json.matches as Array<{ source: string }>;
    expect(new Set(matches.map((m) => m.source))).toEqual(new Set(['knowledge-base', 'memory']));
  });

  it('traces the KB only when botId is omitted', async () => {
    const { status, json } = await api('/trace?q=PgBouncer');
    expect(status).toBe(200);
    expect((json.counts as { memory: number }).memory).toBe(0);
    expect((json.counts as { knowledgeBase: number }).knowledgeBase).toBeGreaterThanOrEqual(1);
  });

  it('returns 400 when q is missing', async () => {
    const { status, json } = await api('/trace');
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/entity query is required/);
  });

  it('returns an extractive no-result summary for unknown entities', async () => {
    const { status, json } = await api('/trace?q=ZzxqyplughNope&botId=bot1');
    expect(status).toBe(200);
    expect(json.matches).toEqual([]);
    expect(json.summaryKind).toBe('extractive');
    expect(String(json.summary)).toMatch(/no matching passages/i);
  });
});

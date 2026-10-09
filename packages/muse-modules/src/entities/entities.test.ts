// SPDX-License-Identifier: Apache-2.0
// Tests for coherence-style entity tracing (lite): cross-source entity
// search over KB chunks + memory atoms with narrative summaries.
// Fully offline — LocalEmbedder + hash embedder + SQLite FTS5, no network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TieredMemoryStore } from '@mvp/agent-runtime';
import { ModuleDb } from '../db.js';
import { KnowledgeBaseStore, LocalEmbedder } from '../knowledge-base/index.js';
import { traceEntity } from './index.js';

let dir: string;
let mdb: ModuleDb;
let kb: KnowledgeBaseStore;
let memory: TieredMemoryStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-entity-'));
  mdb = new ModuleDb(':memory:');
  kb = new KnowledgeBaseStore(mdb, new LocalEmbedder());
  memory = new TieredMemoryStore(dir);

  await kb.addDocument({
    title: 'PostgreSQL pooling',
    fileName: 'pg.md',
    mimeType: 'text/markdown',
    text: 'PgBouncer is a lightweight connection pooler for PostgreSQL. Run it in transaction pooling mode with max_client_conn set high and default_pool_size modest.',
  });
  await kb.addDocument({
    title: 'Unrelated doc',
    fileName: 'other.md',
    mimeType: 'text/markdown',
    text: 'Sourdough starters need twice-daily feeding with equal weights of flour and water.',
  });
  memory.storeAtom('bot1', { fact: 'We run PgBouncer in transaction mode for the billing database.', entities: ['PgBouncer'], confidence: 0.9 }, 's1');
  memory.storeAtom('bot1', { fact: 'The deploy happens on Fridays.', entities: [], confidence: 0.9 }, 's1');
});

afterEach(() => {
  mdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('traceEntity', () => {
  it('returns matches from both sources, sorted by fused score', async () => {
    const res = await traceEntity({ kb, memory, botId: 'bot1', query: 'PgBouncer' });
    expect(res.entity).toBe('PgBouncer');
    expect(res.counts.knowledgeBase).toBeGreaterThanOrEqual(1);
    expect(res.counts.memory).toBeGreaterThanOrEqual(1);
    expect(res.matches.length).toBe(res.counts.knowledgeBase + res.counts.memory);
    const sources = new Set(res.matches.map((m) => m.source));
    expect(sources.has('knowledge-base')).toBe(true);
    expect(sources.has('memory')).toBe(true);
    // sorted desc by score
    for (let i = 1; i < res.matches.length; i++) {
      expect(res.matches[i - 1].score).toBeGreaterThanOrEqual(res.matches[i].score);
    }
    const kbHit = res.matches.find((m) => m.source === 'knowledge-base');
    expect(kbHit && (kbHit as { documentTitle: string }).documentTitle).toBe('PostgreSQL pooling');
  });

  it('defaults to an extractive summary clearly labeled as not generated', async () => {
    const res = await traceEntity({ kb, memory, botId: 'bot1', query: 'PgBouncer' });
    expect(res.summaryKind).toBe('extractive');
    expect(res.summary).toMatch(/extractive/i);
    expect(res.summary).toMatch(/not model-generated/i);
    expect(res.summary).toContain('PgBouncer');
  });

  it('uses the injected summarizer when provided (generated kind)', async () => {
    let seenPrompt = '';
    const res = await traceEntity({
      kb,
      memory,
      botId: 'bot1',
      query: 'PgBouncer',
      summarizer: async (prompt: string) => {
        seenPrompt = prompt;
        return 'PgBouncer pools Postgres connections; memory says billing uses transaction mode.';
      },
    });
    expect(res.summaryKind).toBe('generated');
    expect(res.summary).toContain('pools Postgres connections');
    expect(seenPrompt).toContain('PgBouncer');
    expect(seenPrompt).toContain('Knowledge base:');
  });

  it('falls back to extractive when the summarizer throws', async () => {
    const res = await traceEntity({
      kb,
      memory,
      botId: 'bot1',
      query: 'PgBouncer',
      summarizer: async () => {
        throw new Error('ollama down');
      },
    });
    expect(res.summaryKind).toBe('extractive');
    expect(res.summary).toMatch(/extractive/i);
  });

  it('traces the KB only when botId/memory is omitted', async () => {
    const res = await traceEntity({ kb, query: 'PgBouncer' });
    expect(res.counts.memory).toBe(0);
    expect(res.counts.knowledgeBase).toBeGreaterThanOrEqual(1);
    expect(res.matches.every((m) => m.source === 'knowledge-base')).toBe(true);
  });

  it('memory leg is scoped to the requesting bot', async () => {
    memory.storeAtom('bot2', { fact: 'Bot two also mentions PgBouncer here.', entities: [], confidence: 0.8 }, 's9');
    const res = await traceEntity({ kb, memory, botId: 'bot1', query: 'PgBouncer' });
    const memHits = res.matches.filter((m) => m.source === 'memory');
    expect(memHits.length).toBeGreaterThan(0);
    for (const m of memHits) {
      expect((m as { botId: string }).botId).toBe('bot1');
    }
  });

  it('handles zero matches with an extractive no-result summary', async () => {
    const res = await traceEntity({ kb, memory, botId: 'bot1', query: 'ZzxqyplughNope' });
    expect(res.matches).toEqual([]);
    expect(res.counts).toEqual({ knowledgeBase: 0, memory: 0 });
    expect(res.summaryKind).toBe('extractive');
    expect(res.summary).toMatch(/no matching passages/i);
  });

  it('rejects empty queries', async () => {
    await expect(traceEntity({ kb, query: '   ' })).rejects.toThrow(/entity query is required/);
  });

  it('clamps topK per source', async () => {
    const res = await traceEntity({ kb, memory, botId: 'bot1', query: 'PgBouncer', topK: 1 });
    expect(res.counts.knowledgeBase).toBeLessThanOrEqual(1);
    expect(res.counts.memory).toBeLessThanOrEqual(1);
  });
});

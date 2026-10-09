// SPDX-License-Identifier: Apache-2.0
// Tests for hybrid search primitives and TieredMemoryStore hybrid recall.
// Fully offline — hash embedder + SQLite FTS5 only, no network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TrigramEmbedder,
  buildFtsMatchQuery,
  cosineSimilarity,
  ftsTerms,
  reciprocalRankFuse,
} from '../src/hybrid-search.js';
import { TieredMemoryStore } from '../src/memory.js';

describe('reciprocalRankFuse', () => {
  it('ranks ids appearing early in multiple lists first (k=60 standard)', () => {
    const fused = reciprocalRankFuse(
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
      60,
    );
    // b: 1/62 + 1/61 ; a: 1/61 ; c: 1/62  →  b > a > c
    expect(fused.map((f) => f.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 61, 10);
  });

  it('dedupes repeated ids within one list (first rank wins)', () => {
    const fused = reciprocalRankFuse([['a', 'a', 'b']], 60);
    expect(fused.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('returns [] for empty input', () => {
    expect(reciprocalRankFuse([])).toEqual([]);
    expect(reciprocalRankFuse([[], []])).toEqual([]);
  });

  it('respects a custom k', () => {
    const fused = reciprocalRankFuse([['x']], 1);
    expect(fused[0].score).toBeCloseTo(1 / 2, 10);
  });
});

describe('buildFtsMatchQuery', () => {
  it('quotes terms and OR-joins them', () => {
    expect(buildFtsMatchQuery('dark mode')).toBe('"dark" OR "mode"');
  });

  it('neutralizes FTS5 syntax / quote injection', () => {
    const q = buildFtsMatchQuery('a"b OR 1=1; DROP');
    expect(q).not.toContain('DROP');
    // every term is wrapped in balanced double quotes
    expect(q.split('"').length % 2).toBe(1);
  });

  it('returns empty string when there are no usable terms', () => {
    expect(buildFtsMatchQuery('')).toBe('');
    expect(buildFtsMatchQuery('!!! ???')).toBe('');
    expect(buildFtsMatchQuery('a b c')).toBe(''); // single chars dropped
  });

  it('dedupes and lowercases terms', () => {
    expect(ftsTerms('Dark dark MODE')).toEqual(['dark', 'mode']);
  });
});

describe('TrigramEmbedder', () => {
  const emb = new TrigramEmbedder();

  it('is deterministic', () => {
    const [a] = emb.embedSync(['hello world']);
    const [b] = emb.embedSync(['hello world']);
    expect([...a]).toEqual([...b]);
  });

  it('produces L2-normalized 384-dim vectors', () => {
    const [v] = emb.embedSync(['some text here']);
    expect(v.length).toBe(384);
    let s = 0;
    for (const x of v) s += x * x;
    expect(s).toBeCloseTo(1, 6);
  });

  it('cosineSimilarity is 1 for identical vectors, 0 for disjoint ones', () => {
    const [a] = emb.embedSync(['alpha beta gamma']);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    const z = new Float32Array(384);
    expect(cosineSimilarity(a, z)).toBe(0);
  });
});

describe('TieredMemoryStore hybrid recall', () => {
  let dir: string;
  let store: TieredMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mvp-hybrid-'));
    store = new TieredMemoryStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(botId = 'bot1'): void {
    store.storeAtom(botId, { fact: 'I like dark mode.', entities: [], confidence: 0.8 }, 's1');
    store.storeAtom(botId, { fact: 'My favorite editor is Neovim.', entities: ['Neovim'], confidence: 0.9 }, 's1');
    store.storeAtom(botId, { fact: 'I drink espresso every morning.', entities: [], confidence: 0.7 }, 's1');
    store.storeAtom(botId, { fact: 'Remember that the deploy happens on Fridays.', entities: [], confidence: 0.9 }, 's1');
  }

  it('finds atoms by exact term via the lexical leg', () => {
    seed();
    const hits = store.recallHybrid('bot1', 'Neovim');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].atom.fact).toMatch(/Neovim/);
    expect(hits[0].sources).toContain('lexical');
  });

  it('vector leg retrieves by trigram overlap when the FTS leg is empty', () => {
    seed();
    // Wipe the lexical index: only the vector leg can match now.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(join(dir, 'tiered-memory.db'));
    raw.exec('DELETE FROM memory_atoms_fts');
    raw.close();
    const reopened = new TieredMemoryStore(dir);
    const hits = reopened.recallHybrid('bot1', 'morning espresso');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].atom.fact).toMatch(/espresso/);
    expect(hits[0].sources).toEqual(['vector']);
  });

  it('gibberish queries never reach the lexical leg (RRF floor only)', () => {
    seed();
    const hits = store.recallHybrid('bot1', 'zzz-no-match-zzz');
    // Hash embeddings always rank something; the fused score sits at the
    // single-leg RRF floor (rank 1 in one list → 1/61).
    for (const h of hits) {
      expect(h.sources).toEqual(['vector']);
      // Single-leg hits can never beat the rank-1 RRF floor (1/61).
      expect(h.score).toBeLessThanOrEqual(1 / 61 + 1e-9);
    }
    // ...and the prompt gate keeps them out of the system prompt.
    expect(store.recallForPromptHybrid('bot1', 'zzz-no-match-zzz')).toBe('');
  });

  it('is scoped to the requesting bot', () => {
    seed('bot1');
    store.storeAtom('bot2', { fact: 'Bot two likes Neovim too.', entities: [], confidence: 0.8 }, 's9');
    const hits = store.recallHybrid('bot1', 'Neovim');
    expect(hits.every((h) => h.atom.botId === 'bot1')).toBe(true);
  });

  it('returns [] for empty queries and unknown bots', () => {
    seed();
    expect(store.recallHybrid('bot1', '   ')).toEqual([]);
    expect(store.recallHybrid('nobody', 'Neovim')).toEqual([]);
  });

  it('deleteAtom removes the atom from both retrieval legs', () => {
    seed();
    const id = store.storeAtom('bot1', { fact: 'Zephyr keyboards are great.', entities: [], confidence: 0.8 }, 's2');
    expect(store.recallHybrid('bot1', 'Zephyr').length).toBeGreaterThan(0);
    expect(store.deleteAtom('bot1', id)).toBe(true);
    expect(store.recallHybrid('bot1', 'Zephyr').some((h) => h.atom.id === id)).toBe(false);
  });

  it('backfills embeddings for pre-hybrid atoms', () => {
    // Simulate a database from before hybrid search: wipe embeddings + FTS.
    seed();
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(join(dir, 'tiered-memory.db'));
    raw.exec('UPDATE memory_atoms SET embedding = NULL');
    raw.exec('DELETE FROM memory_atoms_fts');
    raw.close();
    // Reopen: constructor recreates the FTS table (empty now).
    const reopened = new TieredMemoryStore(dir);
    const hits = reopened.recallHybrid('bot1', 'dark mode');
    expect(hits.some((h) => h.atom.fact.includes('dark mode'))).toBe(true);
    expect(hits[0].sources).toContain('vector');
  });

  it('recallForPromptHybrid renders a capped prompt block', () => {
    seed();
    const block = store.recallForPromptHybrid('bot1', 'editor');
    expect(block).toContain('# What I remember');
    expect(block).toContain('Neovim');
    expect(block.length).toBeLessThanOrEqual(2000);
    expect(store.recallForPromptHybrid('bot1', 'zzz-no-match-zzz')).toBe('');
  });

  it('recallForPrompt keeps its original keyword behavior (backward compat)', () => {
    seed();
    const block = store.recallForPrompt('bot1', 'editor');
    expect(block).toContain('Neovim');
  });
});

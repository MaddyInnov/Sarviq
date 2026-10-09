// SPDX-License-Identifier: Apache-2.0
// Coherence-style entity tracing (pragmatic lite version, adapted — not
// copied): cross-source entity search over the knowledge base (chunks) and
// tiered memory (atoms), with a narrative summary of what each source says
// about the entity.
//
// Explicitly OUT of scope: full chapter detection / timeline segmentation.
// The summary is either model-generated (when the host injects a local
// summarizer — Ollama or mock, never a paid API) or clearly labeled as an
// extractive assembly of the top snippets.

import { ValidationError } from '../errors.js';
import { KnowledgeBaseStore } from '../knowledge-base/index.js';
import type { TieredMemoryStore } from '@mvp/agent-runtime';

export interface EntityKbMatch {
  source: 'knowledge-base';
  chunkId: string;
  documentId: string;
  documentTitle: string;
  idx: number;
  page: number | null;
  text: string;
  /** RRF fused score from the KB hybrid retrieval (higher = better). */
  score: number;
  retrievalSources: Array<'vector' | 'lexical'>;
}

export interface EntityMemoryMatch {
  source: 'memory';
  atomId: string;
  botId: string;
  fact: string;
  entities: string[];
  confidence: number;
  /** RRF fused score from the memory hybrid retrieval (higher = better). */
  score: number;
  retrievalSources: Array<'vector' | 'lexical'>;
}

export type EntityMatch = EntityKbMatch | EntityMemoryMatch;

export interface EntityTraceResult {
  /** The entity string as queried. */
  entity: string;
  /** Narrative summary of what the sources say about the entity. */
  summary: string;
  /**
   * 'generated' — written by the injected local summarizer model.
   * 'extractive' — assembled from the top snippets (no model); the summary
   * text itself says so.
   */
  summaryKind: 'generated' | 'extractive';
  /** Matches from both sources, sorted by fused score descending. */
  matches: EntityMatch[];
  counts: { knowledgeBase: number; memory: number };
}

/**
 * Optional local summarizer injected by the host (e.g. an Ollama-backed
 * chat call or a mock in tests). Receives a prompt with the top snippets
 * and returns the narrative. Never a paid API — the platform is
 * local-first by design.
 */
export type EntitySummarizer = (prompt: string) => Promise<string>;

export interface TraceEntityOptions {
  kb: KnowledgeBaseStore;
  /** Tiered memory store; omit (or omit botId) to trace the KB only. */
  memory?: TieredMemoryStore;
  /** Memory is bot-scoped; required for the memory leg. */
  botId?: string;
  /** The entity string to trace, e.g. "PgBouncer". */
  query: string;
  /** Per-source result cap. Default 5, clamped to 1..10. */
  topK?: number;
  /**
   * Local summarizer for the narrative. When omitted (or when it throws),
   * the summary is assembled extractively from the top snippets and
   * explicitly labeled as extractive, not generated.
   */
  summarizer?: EntitySummarizer;
}

const SNIPPET_CHARS = 280;

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > SNIPPET_CHARS ? clean.slice(0, SNIPPET_CHARS) + '…' : clean;
}

/**
 * Trace an entity across the knowledge base and tiered memory.
 * Both legs use hybrid retrieval (vector + FTS5/BM25 + RRF k=60).
 *
 * Relevance gate: hash embeddings rank *something* for every query, so a
 * match is only reported when the lexical leg matched it or its fused
 * score beats the single-leg RRF floor (1/61) via multi-leg agreement —
 * otherwise gibberish entity strings would return noise matches.
 */
export async function traceEntity(opts: TraceEntityOptions): Promise<EntityTraceResult> {
  const entity = opts.query.trim();
  if (!entity) throw new ValidationError('entity query is required');
  const topK = Math.min(Math.max(opts.topK ?? 5, 1), 10);

  const kbMatches: EntityKbMatch[] = (
    await opts.kb.queryHybrid({ query: entity, topK })
  ).map((h) => ({
    source: 'knowledge-base' as const,
    chunkId: h.chunkId,
    documentId: h.documentId,
    documentTitle: h.documentTitle,
    idx: h.idx,
    page: h.page,
    text: h.text,
    score: h.score,
    retrievalSources: h.sources,
  }));

  let memoryMatches: EntityMemoryMatch[] = [];
  if (opts.memory && opts.botId) {
    memoryMatches = opts.memory.recallHybrid(opts.botId, entity, topK).map((h) => ({
      source: 'memory' as const,
      atomId: h.atom.id,
      botId: h.atom.botId,
      fact: h.atom.fact,
      entities: h.atom.entities,
      confidence: h.atom.confidence,
      score: h.score,
      retrievalSources: h.sources,
    }));
  }

  // Rank 1 in a single RRF leg scores exactly 1/61; anything at or below
  // that from the vector leg alone is treated as noise.
  const RRF_SINGLE_LEG_CEIL = 1 / 61 + 1e-9;
  const matches: EntityMatch[] = [...kbMatches, ...memoryMatches]
    .filter((m) => m.retrievalSources.includes('lexical') || m.score > RRF_SINGLE_LEG_CEIL)
    .sort((a, b) => b.score - a.score);
  const kbKept = matches.filter((m): m is EntityKbMatch => m.source === 'knowledge-base');
  const memKept = matches.filter((m): m is EntityMemoryMatch => m.source === 'memory');

  // ---- narrative summary -----------------------------------------------
  let summary: string;
  let summaryKind: EntityTraceResult['summaryKind'] = 'extractive';
  if (opts.summarizer && matches.length > 0) {
    try {
      summary = await opts.summarizer(buildTracePrompt(entity, kbKept, memKept));
      summaryKind = 'generated';
    } catch {
      summary = extractiveSummary(entity, kbKept, memKept);
    }
  } else {
    summary = extractiveSummary(entity, kbKept, memKept);
  }

  return {
    entity,
    summary,
    summaryKind,
    matches,
    counts: { knowledgeBase: kbKept.length, memory: memKept.length },
  };
}

function buildTracePrompt(entity: string, kb: EntityKbMatch[], mem: EntityMemoryMatch[]): string {
  const lines: string[] = [
    `Summarize what the sources below say about "${entity}" in 3-5 sentences.`,
    'Stick to what the sources state; do not invent details.',
    '',
  ];
  if (kb.length > 0) {
    lines.push('Knowledge base:');
    kb.forEach((m, i) => lines.push(`[${i + 1}] (${m.documentTitle}) ${snippet(m.text)}`));
    lines.push('');
  }
  if (mem.length > 0) {
    lines.push('Memory:');
    mem.forEach((m, i) => lines.push(`[${i + 1}] ${snippet(m.fact)}`));
  }
  return lines.join('\n');
}

/**
 * Extractive narrative: groups the top snippets by source with explicit
 * labeling that the text is assembled from sources, NOT model-generated.
 */
function extractiveSummary(entity: string, kb: EntityKbMatch[], mem: EntityMemoryMatch[]): string {
  const total = kb.length + mem.length;
  if (total === 0) {
    return (
      `Extractive summary for "${entity}": no matching passages found in the ` +
      `knowledge base or memory. (Extractive — assembled from source snippets, not model-generated.)`
    );
  }
  const parts: string[] = [
    `Extractive summary for "${entity}" — assembled from the top ${total} matching ` +
      `snippet${total === 1 ? '' : 's'} (no local summarizer configured; this text is ` +
      `quoted/condensed from sources, not model-generated):`,
  ];
  if (kb.length > 0) {
    parts.push(`Knowledge base (${kb.length}):`);
    kb.slice(0, 3).forEach((m, i) => parts.push(`  ${i + 1}. [${m.documentTitle}] ${snippet(m.text)}`));
  }
  if (mem.length > 0) {
    parts.push(`Memory (${mem.length}):`);
    mem.slice(0, 3).forEach((m, i) => parts.push(`  ${i + 1}. ${snippet(m.fact)}`));
  }
  return parts.join('\n');
}

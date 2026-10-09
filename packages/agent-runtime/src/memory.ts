// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolDefinition } from './types.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

/**
 * Bot ids are used as file names, so restrict them to a safe alphabet.
 * Rejects path traversal (e.g. "../../etc") fail-closed.
 */
const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function checkBotId(botId: string): void {
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new Error(
      `Invalid bot id "${botId}": must match ${BOT_ID_PATTERN.source} (memory file names are derived from bot ids)`,
    );
  }
}

/**
 * Per-bot persistent memory: one markdown file per bot at
 * `<dataDir>/memories/<botId>.md`. Survives sessions and restarts — it is
 * just a file on disk.
 *
 * Two write modes:
 * - append(): timestamped journal entries (bot's memory_store tool).
 * - replace(): full rewrite (used by the Workspace UI's memory editor).
 *
 * NOTE (follow-up for the Workspace UI, owned by the top coordinator):
 * expose this over HTTP as GET/PUT /api/bots/:id/memory so users can read
 * and edit bot memory from the dashboard. The store class below is already
 * safe to call from a route handler.
 */
export class BotMemoryStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'memories');
  }

  /** Absolute path of a bot's memory file (handy for debugging/tests). */
  path(botId: string): string {
    checkBotId(botId);
    return join(this.dir, `${botId}.md`);
  }

  /** Read the bot's memory file; returns '' when it has no memory yet. */
  read(botId: string): string {
    checkBotId(botId);
    try {
      return readFileSync(this.path(botId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  /** Append a timestamped markdown section. Creates the dir/file as needed. */
  append(botId: string, entry: string): void {
    checkBotId(botId);
    const text = entry.trim();
    if (!text) throw new Error('memory_store: "entry" must be a non-empty string');
    mkdirSync(this.dir, { recursive: true });
    const existing = this.read(botId);
    const section = `## ${new Date().toISOString()}\n\n${text}\n`;
    const next = existing ? (existing.endsWith('\n') ? existing : existing + '\n') + '\n' + section : section;
    writeFileSync(this.path(botId), next, 'utf8');
  }

  /** Full replace of the memory file (user edits from the UI). */
  replace(botId: string, content: string): void {
    checkBotId(botId);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(botId), content, 'utf8');
  }
}

export interface CreateMemoryToolsOptions {
  store: BotMemoryStore;
}

/**
 * Two tools, both scoped to the calling bot via ctx.botId:
 * - memory_recall: returns the bot's memory file content ('' if none yet).
 * - memory_store: appends a timestamped fact to the bot's memory.
 *
 * Governance: memory_store is a write tool, so it goes through the normal
 * approval flow like any other tool — nothing here bypasses Phase 1 policy.
 * Deliberately minimal: no system-prompt injection; the bot discovers its
 * memory through the tool descriptions, which the model sees.
 */
export function createMemoryTools(opts: CreateMemoryToolsOptions): ToolDefinition[] {
  const { store } = opts;

  const recall: ToolDefinition = {
    name: 'memory_recall',
    description:
      'Read your persistent memory: durable facts you chose to remember across ' +
      'conversations (preferences, project state, user details). Returns the ' +
      'memory file content, or empty text if nothing is stored yet. Call it ' +
      'when past context would help the current task.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args: Record<string, unknown>, ctx: ToolContext) => {
      return { content: store.read(ctx.botId) };
    },
  };

  const storeTool: ToolDefinition = {
    name: 'memory_store',
    description:
      'Save a durable fact to your persistent memory (survives sessions). ' +
      'Use for user preferences, project decisions, and anything you will ' +
      'need in future conversations. Do NOT store secrets, credentials, or ' +
      'private data the user did not ask you to remember.',
    parameters: {
      type: 'object',
      properties: {
        entry: {
          type: 'string',
          description: 'The fact to remember, as a short markdown paragraph.',
        },
      },
      required: ['entry'],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const entry = typeof args.entry === 'string' ? args.entry : '';
      store.append(ctx.botId, entry);
      return { stored: true, botId: ctx.botId };
    },
  };

  return [recall, storeTool];
}

// ===========================================================================
// Tiered memory (Octop parity): L0 raw events → L2 atom cards → L3 entity pages.
//
// L0: every turn's raw user/assistant text + tool calls, stored as events.
// L2: durable facts distilled from turns into AtomCards (deduped).
// L3: per-entity pages aggregating the atoms that mention an entity.
//
// Distillation runs async and non-blocking after each turn (ingestTurn).
// Recall is a cheap keyword lookup injected into the system prompt at turn
// start ("What I remember"), capped at ~500 tokens.
// ===========================================================================

/** L0: a raw turn event. */
export interface MemoryEvent {
  id: string;
  ts: number;
  botId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: string[];
}

/** L2: a distilled durable fact card. */
export interface AtomCard {
  id: string;
  botId: string;
  fact: string;
  entities: string[];
  confidence: number;
  sourceTurn: string;
  createdAt: number;
}

/** L3: an entity page aggregating atoms. */
export interface EntityPage {
  entity: string;
  botId: string;
  summary: string;
  atomIds: string[];
  updatedAt: number;
}

/** One distilled fact, before persistence. */
export interface DistilledFact {
  fact: string;
  entities: string[];
  confidence: number;
}

/**
 * Optional LLM distiller injected by the host. Receives the turn text
 * (user + assistant) and returns durable facts. When absent, the heuristic
 * extractor below is used — no model call, no latency, no cost.
 */
export type LlmDistiller = (turnText: string) => Promise<DistilledFact[]>;

const ATOM_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_atoms (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    fact_norm TEXT NOT NULL,
    entities_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_turn TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_atoms_bot ON memory_atoms(bot_id);
  CREATE INDEX IF NOT EXISTS idx_memory_atoms_norm ON memory_atoms(bot_id, fact_norm);
`;

const ENTITY_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_entities (
    bot_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_norm TEXT NOT NULL,
    summary TEXT NOT NULL,
    atom_ids_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, entity_norm)
  );
`;

const EVENT_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    tool_calls_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_events_bot ON memory_events(bot_id, ts);
`;

function normFact(fact: string): string {
  return fact.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normEntity(entity: string): string {
  return entity.toLowerCase().trim();
}

/**
 * Heuristic fact extractor (no LLM needed). Catches durable personal facts:
 * preferences ("I like/prefer/love/hate X"), identity ("my X is Y", "call me X",
 * "I am a/an X"), and explicit memory requests ("remember that X").
 */
export function heuristicDistill(text: string): DistilledFact[] {
  const facts: DistilledFact[] = [];
  const seen = new Set<string>();
  const push = (fact: string, entities: string[], confidence: number) => {
    const key = normFact(fact);
    if (key.length < 8 || seen.has(key)) return;
    seen.add(key);
    facts.push({ fact: fact.trim(), entities, confidence });
  };

  // Split into sentences; keep it simple and dependency-free.
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

  const prefRe = /\b(i (?:like|love|prefer|hate|dislike|enjoy))\b\s+(.+)/i;
  const myIsRe = /\bmy ([\w ]{1,40}?) (?:is|are)\b\s+(.+)/i;
  const callMeRe = /\bcall me ([\w-]{1,40})/i;
  const iAmRe = /\bi am (?:a |an )?([\w ]{1,60})/i;
  const rememberRe = /\bremember that\b\s+(.+)/i;

  for (const s of sentences) {
    if (s.length > 400) continue; // skip walls of text
    let m: RegExpMatchArray | null;
    if ((m = s.match(prefRe))) {
      push(`${capitalize(m[1])} ${m[2]}.`, extractEntities(m[2]), 0.8);
    } else if ((m = s.match(rememberRe))) {
      push(`Remember: ${m[1]}.`, extractEntities(m[1]), 0.9);
    } else if ((m = s.match(callMeRe))) {
      push(`The user's preferred name is "${m[1]}".`, [m[1]], 0.95);
    } else if ((m = s.match(myIsRe))) {
      push(`The user's ${m[1].trim()} is ${m[2]}.`, extractEntities(m[1] + ' ' + m[2]), 0.75);
    } else if ((m = s.match(iAmRe))) {
      push(`The user is ${m[1].trim()}.`, extractEntities(m[1]), 0.7);
    }
  }
  return facts;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Crude entity extraction: capitalized words/phrases (proper nouns). */
function extractEntities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    const e = m[1].trim();
    if (e.length > 1 && !/^(I|My|The|This|That)$/.test(e)) out.add(e);
  }
  return [...out].slice(0, 6);
}

export interface TieredMemoryOptions {
  /** Injected LLM distiller; heuristic fallback when absent. */
  distiller?: LlmDistiller;
}

export class TieredMemoryStore {
  private readonly db: DatabaseSyncType;
  private readonly distiller?: LlmDistiller;

  constructor(dataDir: string, opts: TieredMemoryOptions = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'tiered-memory.db'));
    this.db.exec(ATOM_TABLE);
    this.db.exec(ENTITY_TABLE);
    this.db.exec(EVENT_TABLE);
    this.distiller = opts.distiller;
  }

  // ---- L0: raw events -----------------------------------------------------

  recordEvent(botId: string, sessionId: string, role: 'user' | 'assistant', text: string, toolCalls: string[] = []): MemoryEvent {
    const ev: MemoryEvent = {
      id: randomUUID(),
      ts: Date.now(),
      botId,
      sessionId,
      role,
      text: text.slice(0, 8000),
      toolCalls,
    };
    this.db
      .prepare('INSERT INTO memory_events (id, ts, bot_id, session_id, role, text, tool_calls_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ev.id, ev.ts, ev.botId, ev.sessionId, ev.role, ev.text, JSON.stringify(ev.toolCalls));
    return ev;
  }

  // ---- Turn ingestion (async, non-blocking) --------------------------------

  /**
   * Record a completed turn's L0 events and kick off L2 distillation in the
   * background. Never throws into the caller; never blocks the turn.
   */
  ingestTurn(botId: string, sessionId: string, userText: string, assistantText: string, toolCalls: string[] = []): void {
    try {
      this.recordEvent(botId, sessionId, 'user', userText);
      this.recordEvent(botId, sessionId, 'assistant', assistantText, toolCalls);
    } catch {
      return; // memory must never break chat
    }
    // Fire-and-forget distillation.
    const turnText = `User: ${userText}\nAssistant: ${assistantText}`;
    void this.distillAndStore(botId, sessionId, turnText).catch(() => undefined);
  }

  private async distillAndStore(botId: string, sessionId: string, turnText: string): Promise<void> {
    let facts: DistilledFact[];
    try {
      facts = this.distiller ? await this.distiller(turnText) : heuristicDistill(turnText);
    } catch {
      return;
    }
    for (const f of facts) {
      try {
        this.storeAtom(botId, f, sessionId);
      } catch {
        // skip bad facts, keep going
      }
    }
  }

  // ---- L2: atoms ------------------------------------------------------------

  /**
   * Store one atom, deduped against existing atoms (normalized-text match).
   * Returns the atom id, or the existing id when deduped.
   */
  storeAtom(botId: string, fact: DistilledFact, sourceTurn: string): string {
    const factText = fact.fact.trim().slice(0, 500);
    if (!factText) throw new Error('fact must be non-empty');
    const factNorm = normFact(factText);
    const existing = this.db
      .prepare('SELECT id FROM memory_atoms WHERE bot_id = ? AND fact_norm = ? LIMIT 1')
      .get(botId, factNorm) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = randomUUID();
    const entities = [...new Set(fact.entities.map((e) => e.trim()).filter(Boolean))].slice(0, 10);
    this.db
      .prepare(
        'INSERT INTO memory_atoms (id, bot_id, fact, fact_norm, entities_json, confidence, source_turn, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, factText, factNorm, JSON.stringify(entities), Math.min(1, Math.max(0, fact.confidence)), sourceTurn, Date.now());
    this.refreshEntityPages(botId, entities, id);
    return id;
  }

  getAtoms(botId: string, limit = 200): AtomCard[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_atoms WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(botId, limit) as Array<{
        id: string; bot_id: string; fact: string; entities_json: string;
        confidence: number; source_turn: string; created_at: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      botId: r.bot_id,
      fact: r.fact,
      entities: JSON.parse(r.entities_json) as string[],
      confidence: r.confidence,
      sourceTurn: r.source_turn,
      createdAt: r.created_at,
    }));
  }

  deleteAtom(botId: string, id: string): boolean {
    const res = this.db.prepare('DELETE FROM memory_atoms WHERE bot_id = ? AND id = ?').run(botId, id);
    return res.changes > 0;
  }

  // ---- L3: entity pages -------------------------------------------------------

  private refreshEntityPages(botId: string, entities: string[], _newAtomId: string): void {
    for (const entity of entities) {
      const eNorm = normEntity(entity);
      if (!eNorm) continue;
      const atoms = this.db
        .prepare(
          `SELECT id, fact, confidence, entities_json FROM memory_atoms WHERE bot_id = ?
           ORDER BY created_at DESC LIMIT 200`,
        )
        .all(botId) as Array<{ id: string; fact: string; confidence: number; entities_json: string }>;
      const matching = atoms
        .filter((a) => {
          try {
            const ents = JSON.parse(a.entities_json) as string[];
            return ents.some((e) => normEntity(e) === eNorm);
          } catch {
            return false;
          }
        })
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 20);
      const summary =
        matching.length === 0
          ? `No facts recorded about ${entity} yet.`
          : `Known about ${entity} (${matching.length} fact${matching.length === 1 ? '' : 's'}): ` +
            matching.map((a) => a.fact).join(' ');
      this.db
        .prepare(
          `INSERT INTO memory_entities (bot_id, entity, entity_norm, summary, atom_ids_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(bot_id, entity_norm) DO UPDATE SET
             summary = excluded.summary,
             atom_ids_json = excluded.atom_ids_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          botId,
          entity,
          eNorm,
          summary.slice(0, 2000),
          JSON.stringify(matching.map((a) => a.id)),
          Date.now(),
        );
    }
  }

  getEntities(botId: string): EntityPage[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_entities WHERE bot_id = ? ORDER BY updated_at DESC')
      .all(botId) as Array<{
        entity: string; bot_id: string; summary: string; atom_ids_json: string; updated_at: number;
      }>;
    return rows.map((r) => ({
      entity: r.entity,
      botId: r.bot_id,
      summary: r.summary,
      atomIds: JSON.parse(r.atom_ids_json) as string[],
      updatedAt: r.updated_at,
    }));
  }

  // ---- Recall -----------------------------------------------------------------

  /**
   * Retrieve atoms relevant to `query` (keyword match on entities + fact
   * text, ranked by overlap then confidence) and render a compact
   * "What I remember" block capped at ~500 tokens (~2000 chars).
   */
  recallForPrompt(botId: string, query: string, maxChars = 2000): string {
    const atoms = this.getAtoms(botId, 500);
    if (atoms.length === 0) return '';
    const qTokens = new Set(normFact(query).split(' ').filter((t) => t.length > 2));
    if (qTokens.size === 0) return '';

    const scored = atoms
      .map((a) => {
        const hay = normFact(a.fact + ' ' + a.entities.join(' '));
        let overlap = 0;
        for (const t of qTokens) if (hay.includes(t)) overlap++;
        return { atom: a, overlap };
      })
      .filter((s) => s.overlap > 0)
      .sort((x, y) => y.overlap - x.overlap || y.atom.confidence - x.atom.confidence)
      .slice(0, 12);

    if (scored.length === 0) return '';
    let block = '# What I remember (from past conversations)\n';
    for (const { atom } of scored) {
      const line = `- ${atom.fact}\n`;
      if (block.length + line.length > maxChars) break;
      block += line;
    }
    return block;
  }
}

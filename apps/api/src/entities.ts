// SPDX-License-Identifier: Apache-2.0
// Entity tracing endpoint (coherence-lite): cross-source entity search over
// the knowledge base (chunks) and tiered memory (atoms), with a narrative
// summary. Mounted at /api/entities (see routes.ts).
//
//   GET /api/entities/trace?q=PgBouncer&botId=<id>&topK=5
//     → { entity, summary, summaryKind: 'extractive' | 'generated',
//         matches: [...], counts: { knowledgeBase, memory } }
//
// Memory is bot-scoped: omit botId to trace the knowledge base only.
// Summaries are extractive by default (clearly labeled as such); a host can
// inject a local summarizer via deps.summarizer (Ollama/mock — never paid).

import { Router } from 'express';
import type { Request, Response } from 'express';
import { join } from 'node:path';
import {
  KnowledgeBaseStore,
  LocalEmbedder,
  ModuleDb,
  messageForError,
  statusForError,
  traceEntity,
  type EntitySummarizer,
} from '@mvp/muse-modules';
import type { TieredMemoryStore } from '@mvp/agent-runtime';

export interface EntityTraceRouteDeps {
  dataDir: string;
  memoryStore: TieredMemoryStore;
  /** Optional local summarizer (Ollama/mock). Extractive default when omitted. */
  summarizer?: EntitySummarizer;
}

export function registerEntityTraceRoutes(router: Router, deps: EntityTraceRouteDeps): void {
  // Shares the muse-modules.db file with the module routes (separate
  // connection; the FTS5 table is created idempotently by ModuleDb).
  const mdb = new ModuleDb(join(deps.dataDir, 'muse-modules.db'));
  const kb = new KnowledgeBaseStore(mdb, new LocalEmbedder());

  router.get('/trace', async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const botId =
        typeof req.query.botId === 'string' && req.query.botId.trim() ? req.query.botId : undefined;
      const rawTopK = typeof req.query.topK === 'string' ? Number.parseInt(req.query.topK, 10) : NaN;
      const result = await traceEntity({
        kb,
        memory: deps.memoryStore,
        botId,
        query: q,
        topK: Number.isFinite(rawTopK) ? rawTopK : 5,
        summarizer: deps.summarizer,
      });
      res.json(result);
    } catch (err) {
      res.status(statusForError(err)).json({ error: messageForError(err, 'failed to trace entity') });
    }
  });
}

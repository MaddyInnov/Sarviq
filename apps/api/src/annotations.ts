// SPDX-License-Identifier: Apache-2.0
// External-assistant annotations with strict separation from measured data.
//
// GOVERNANCE PATTERN (read-only assistant connections):
//   External assistants connecting over our MCP server get a
//   "read-only-assistant" connection class (see mcp-annotations.ts):
//     - They may READ telemetry/resources freely (telemetry lives in its own
//       stores, e.g. agent.db — annotations never touch those stores).
//     - They may only APPEND notes/reports/promises via the
//       `annotations.append` MCP tool. Appending is the single write they
//       are allowed; every other write/egress tool is denied.
//     - Appended items land in the annotations store BELOW — a dedicated
//       append-only JSON file (`<dataDir>/annotations.json`), physically
//       separate from every telemetry store.
//     - New items are `pending` until a human approves or dismisses them in
//       the review queue (GET /api/annotations/pending,
//       POST /api/annotations/:id/review). Nothing the assistant writes is
//       ever presented as measured data.
//   Measured telemetry and annotations never mix: separate storage files,
//   separate API sections, and annotation responses are explicitly labeled
//   (each record carries `record: 'annotation'`), so a consumer can never
//   mistake an assistant's note for a platform measurement.
//
// The store itself is append-only by construction: it exposes append(),
// review(), list(), and get() — no update(), no remove(). Review only flips
// the `status` field from `pending` to `approved`/`dismissed`.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

/** What kind of thing the external assistant appended. */
export type AnnotationKind = 'note' | 'report' | 'promise';

/** Review lifecycle: pending → approved | dismissed. Terminal, one-way. */
export type AnnotationStatus = 'pending' | 'approved' | 'dismissed';

export interface Annotation {
  /** Explicit label: this is an assistant annotation, NOT measured data. */
  record: 'annotation';
  id: string;
  kind: AnnotationKind;
  /** The assistant's own words. */
  content: string;
  /** Which external assistant/connection appended it. */
  source: string;
  createdAt: number;
  status: AnnotationStatus;
  reviewedAt?: number;
  reviewedBy?: string;
}

type AnnotationRow = Annotation;

/**
 * Append-only JSON-file store: `<dataDir>/annotations.json`.
 * Sync, single-process persistence — same style as NoteStore.
 */
export class AnnotationStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'annotations.json');
  }

  /** Absolute path of the backing file (handy for debugging/tests). */
  path(): string {
    return this.file;
  }

  private readAll(): AnnotationRow[] {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isAnnotationRow);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private writeAll(rows: AnnotationRow[]): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rows, null, 2), 'utf8');
  }

  /** Append one annotation. Always starts `pending` — never trusted on write. */
  append(input: { kind: string; content: string; source?: string }): Annotation {
    const kind = requireKind(input.kind);
    const content = requireContent(input.content);
    const source = requireSource(input.source);
    const rows = this.readAll();
    // Monotonic across the store so ordering (oldest/newest first) is
    // deterministic even when appends land in the same millisecond.
    const now = rows.reduce((m, r) => Math.max(m, r.createdAt), Date.now()) + 1;
    const row: Annotation = {
      record: 'annotation',
      id: randomUUID(),
      kind,
      content,
      source,
      createdAt: now,
      status: 'pending',
    };
    rows.push(row);
    this.writeAll(rows);
    return row;
  }

  /**
   * Human review: move a pending annotation to approved/dismissed.
   * One-way — reviewed items cannot return to pending.
   */
  review(id: string, decision: 'approve' | 'dismiss', reviewer?: string): Annotation {
    if (decision !== 'approve' && decision !== 'dismiss') {
      throw validationError(`"decision" must be "approve" or "dismiss", got ${JSON.stringify(decision)}`);
    }
    const rows = this.readAll();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) throw notFound(id);
    const current = rows[idx];
    if (current.status !== 'pending') {
      throw validationError(`annotation ${id} is already ${current.status} — review is one-way`);
    }
    const next: Annotation = {
      ...current,
      status: decision === 'approve' ? 'approved' : 'dismissed',
      // append() pushes createdAt up to +1ms into the future for monotonic
      // ordering; clamp reviewedAt so it never precedes creation.
      reviewedAt: Math.max(Date.now(), current.createdAt),
      reviewedBy: reviewer?.trim() ? reviewer.trim().slice(0, 200) : 'human',
    };
    rows[idx] = next;
    this.writeAll(rows);
    return next;
  }

  /** All annotations, newest first. */
  list(): Annotation[] {
    return this.readAll().sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }

  /** The human review queue: pending items, oldest first. */
  listPending(): Annotation[] {
    return this.readAll()
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  get(id: string): Annotation | undefined {
    return this.readAll().find((r) => r.id === id);
  }
}

export interface AnnotationRouteDeps {
  dataDir: string;
  /** Optional pre-built store (tests inject their own dataDir normally). */
  annotationStore?: AnnotationStore;
}

// Routes (router mounted at /api/annotations):
//   GET    /            → { annotations: Annotation[] } (all, labeled)
//   GET    /pending     → { annotations: Annotation[] } (review queue)
//   POST   /            → { kind, content, source? } → Annotation (201, pending)
//   GET    /:id         → Annotation
//   POST   /:id/review  → { decision: 'approve'|'dismiss', reviewer? } → Annotation
//
// NOTE: this router serves ONLY annotations. Telemetry endpoints never
// include annotation records, and annotation responses never include
// telemetry — the separation is structural, not a filter flag.
export function registerAnnotationRoutes(router: Router, deps: AnnotationRouteDeps): void {
  const store = deps.annotationStore ?? new AnnotationStore(deps.dataDir);

  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json({ annotations: store.list() });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list annotations') });
    }
  });

  router.get('/pending', (_req: Request, res: Response) => {
    try {
      res.json({ annotations: store.listPending() });
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list pending annotations') });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { kind?: unknown; content?: unknown; source?: unknown };
      const annotation = store.append({
        kind: body.kind as string,
        content: body.content as string,
        source: body.source as string | undefined,
      });
      res.status(201).json(annotation);
    } catch (err) {
      const message = errMessage(err, 'failed to append annotation');
      res.status(isValidationError(err) ? 400 : 500).json({ error: message });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    const annotation = store.get(req.params.id);
    if (!annotation) {
      res.status(404).json({ error: `unknown annotation: ${req.params.id}` });
      return;
    }
    res.json(annotation);
  });

  router.post('/:id/review', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { decision?: unknown; reviewer?: unknown };
      const annotation = store.review(
        req.params.id,
        body.decision as 'approve' | 'dismiss',
        body.reviewer as string | undefined,
      );
      res.json(annotation);
    } catch (err) {
      const message = errMessage(err, 'failed to review annotation');
      const status = isNotFoundError(err) ? 404 : isValidationError(err) ? 400 : 500;
      res.status(status).json({ error: message });
    }
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const KINDS: ReadonlySet<string> = new Set(['note', 'report', 'promise']);

function isAnnotationRow(v: unknown): v is AnnotationRow {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.record === 'annotation' &&
    typeof o.id === 'string' &&
    typeof o.kind === 'string' &&
    KINDS.has(o.kind) &&
    typeof o.content === 'string' &&
    typeof o.source === 'string' &&
    typeof o.createdAt === 'number' &&
    (o.status === 'pending' || o.status === 'approved' || o.status === 'dismissed')
  );
}

function requireKind(kind: unknown): AnnotationKind {
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw validationError(`"kind" must be one of ${[...KINDS].join(', ')}, got ${JSON.stringify(kind)}`);
  }
  return kind as AnnotationKind;
}

function requireContent(content: unknown): string {
  if (typeof content !== 'string' || !content.trim()) {
    throw validationError('"content" must be a non-empty string');
  }
  if (content.length > 10000) throw validationError('"content" must be at most 10000 chars');
  return content;
}

function requireSource(source: unknown): string {
  if (source === undefined) return 'external-assistant';
  if (typeof source !== 'string' || !source.trim()) {
    throw validationError('"source" must be a non-empty string');
  }
  return source.trim().slice(0, 200);
}

const NOT_FOUND_MARK = '__annotation_not_found__';
const VALIDATION_MARK = '__annotation_validation__';

function notFound(id: string): Error {
  const err = new Error(`unknown annotation: ${id}`);
  (err as Error & { code?: string }).code = NOT_FOUND_MARK;
  return err;
}

function validationError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = VALIDATION_MARK;
  return err;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === NOT_FOUND_MARK;
}

function isValidationError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === VALIDATION_MARK;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

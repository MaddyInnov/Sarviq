// SPDX-License-Identifier: Apache-2.0
// User markdown notes: simple personal notes, separate from per-bot memory.
// (BotMemoryStore in @mvp/agent-runtime holds *bot* memory; these are the
// *user's own* notes. Same store style: sync JSON-file persistence under the
// data dir, no secrets ever stored here.)
//
// Mount at boot, e.g.:
//   import { registerNotesRoutes } from './notes.js';
//   const notesRouter = express.Router();
//   registerNotesRoutes(notesRouter, { dataDir: config.dataDir });
//   app.use('/api/notes', notesRouter);
//
// Routes (router mounted at /api/notes):
//   GET    /            → Note[]
//   POST   /            → { id, title, content } → Note (201)
//   GET    /:id         → Note
//   PUT    /:id         → { title?, content? } → Note
//   DELETE /:id         → { ok: true }

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { KnowledgeIndex } from './knowledge.js';

export interface Note {
  id: string;
  title: string;
  /** Markdown content. */
  content: string;
  createdAt: number;
  updatedAt: number;
}

type NoteRow = Note;

/**
 * JSON-file persistence for user notes: `<dataDir>/notes.json`.
 * Sync, crash-safe enough for single-process MVP use — same style as
 * BotMemoryStore (mkdir -p + atomic full-file rewrite).
 */
export class NoteStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'notes.json');
  }

  /** Absolute path of the backing file (handy for debugging/tests). */
  path(): string {
    return this.file;
  }

  private readAll(): NoteRow[] {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isNoteRow);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private writeAll(rows: NoteRow[]): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    // Write-then-rename would be nicer, but keep the memory.ts pattern:
    // single full-file write under the data dir.
    writeFileSync(this.file, JSON.stringify(rows, null, 2), 'utf8');
  }

  list(): Note[] {
    // Most recently updated first; on ties (same ms), most recently created
    // first so the order is deterministic.
    return this.readAll()
      .map((note, index) => ({ note, index }))
      .sort(
        (a, b) =>
          b.note.updatedAt - a.note.updatedAt ||
          b.note.createdAt - a.note.createdAt ||
          b.index - a.index,
      )
      .map(({ note }) => note);
  }

  get(id: string): Note | undefined {
    return this.readAll().find((n) => n.id === id);
  }

  create(input: { title: string; content?: string }): Note {
    const title = requireTitle(input.title);
    const now = Date.now();
    const note: Note = {
      id: randomUUID(),
      title,
      content: typeof input.content === 'string' ? input.content : '',
      createdAt: now,
      updatedAt: now,
    };
    const rows = this.readAll();
    rows.push(note);
    this.writeAll(rows);
    return note;
  }

  update(id: string, input: { title?: string; content?: string }): Note {
    const rows = this.readAll();
    const idx = rows.findIndex((n) => n.id === id);
    if (idx === -1) throw noteNotFound(id);
    const current = rows[idx];
    const next: Note = {
      ...current,
      title: input.title === undefined ? current.title : requireTitle(input.title),
      content: input.content === undefined ? current.content : requireContent(input.content),
      // Monotonic: an update must always sort after the previous state, even
      // when two ops land in the same millisecond.
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    rows[idx] = next;
    this.writeAll(rows);
    return next;
  }

  remove(id: string): void {
    const rows = this.readAll();
    const idx = rows.findIndex((n) => n.id === id);
    if (idx === -1) throw noteNotFound(id);
    rows.splice(idx, 1);
    this.writeAll(rows);
  }
}

export interface NotesDeps {
  dataDir: string;
  /** Optional pre-built store (tests inject their own dataDir normally). */
  noteStore?: NoteStore;
}

export function registerNotesRoutes(router: Router, deps: NotesDeps): void {
  const store = deps.noteStore ?? new NoteStore(deps.dataDir);

  router.get('/', (req: Request, res: Response) => {
    try {
      // Obsidian-style tag filter: GET /api/notes?tag=foo
      const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
      if (tag && tag.trim()) {
        res.json(new KnowledgeIndex(store).notesByTag(tag));
        return;
      }
      res.json(store.list());
    } catch (err) {
      res.status(500).json({ error: errMessage(err, 'failed to list notes') });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { title?: unknown; content?: unknown };
      const note = store.create({
        title: body.title as string,
        content: body.content as string | undefined,
      });
      res.status(201).json(note);
    } catch (err) {
      const message = errMessage(err, 'failed to create note');
      res.status(isValidationError(err) ? 400 : 500).json({ error: message });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    const note = store.get(req.params.id);
    if (!note) {
      res.status(404).json({ error: `unknown note: ${req.params.id}` });
      return;
    }
    res.json(note);
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { title?: unknown; content?: unknown };
      const note = store.update(req.params.id, {
        title: body.title as string | undefined,
        content: body.content as string | undefined,
      });
      res.json(note);
    } catch (err) {
      const message = errMessage(err, 'failed to update note');
      res.status(isNotFoundError(err) ? 404 : isValidationError(err) ? 400 : 500).json({ error: message });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      store.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const message = errMessage(err, 'failed to delete note');
      res.status(isNotFoundError(err) ? 404 : 500).json({ error: message });
    }
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const TITLE_PATTERN = /^[\s\S]{1,200}$/;

function isNoteRow(v: unknown): v is NoteRow {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.content === 'string' &&
    typeof o.createdAt === 'number' &&
    typeof o.updatedAt === 'number'
  );
}

function requireTitle(title: unknown): string {
  if (typeof title !== 'string' || !TITLE_PATTERN.test(title.trim())) {
    throw validationError('note "title" must be a non-empty string (max 200 chars)');
  }
  return title.trim();
}

function requireContent(content: unknown): string {
  if (typeof content !== 'string') throw validationError('note "content" must be a string');
  return content;
}

const NOT_FOUND_MARK = '__note_not_found__';
const VALIDATION_MARK = '__note_validation__';

function noteNotFound(id: string): Error {
  const err = new Error(`unknown note: ${id}`);
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

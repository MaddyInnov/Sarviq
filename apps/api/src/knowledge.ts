// SPDX-License-Identifier: Apache-2.0
// Obsidian-style knowledge management on top of user notes.
//
// Builds on NoteStore (apps/api/src/notes.ts — JSON-file persistence) without
// changing it: wiki-links, backlinks, graph, tags, daily notes, full-text
// search, and rename propagation are all computed from note content.
//
// Mount BEFORE registerNotesRoutes on the same router, because /graph,
// /search, /tags and /daily would otherwise be swallowed by /:id:
//
//   const notesRouter = express.Router();
//   registerKnowledgeRoutes(notesRouter, { dataDir: config.dataDir });
//   registerNotesRoutes(notesRouter, { dataDir: config.dataDir });
//   app.use('/api/notes', notesRouter);
//
// Routes (router mounted at /api/notes):
//   GET    /graph              → { nodes, edges }
//   GET    /tags               → { tags: Record<tag, string[]> } (tag → note ids)
//   GET    /search?q=          → Note[] (title + content, title matches first)
//   GET    /daily/:date        → Note (get-or-create, date = YYYY-MM-DD)
//   POST   /daily              → Note (get-or-create today's note)
//   GET    /:id/backlinks      → Note[] (notes linking TO this note)
//   POST   /:id/rename         → { title } → { note, updatedNoteIds }
//   GET    /?tag=foo           → handled by extending registerNotesRoutes' GET /
//                                (see notes.ts — filter by tag)

import { Router } from 'express';
import type { Request, Response } from 'express';
import { NoteStore, type Note } from './notes.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface WikiLink {
  /** The link target as written (note title). */
  target: string;
  /** Display alias for [[target|alias]], else undefined. */
  alias?: string;
  /** The raw [[...]] text. */
  raw: string;
}

const WIKI_LINK_RE = /\[\[([^\]|[\n]+)(?:\|([^\][\n]*))?\]\]/g;

/**
 * Extract wiki-links from markdown content. Code blocks are skipped so
 * `[[...]]` inside fenced code doesn't create phantom links.
 */
export function parseWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  const stripped = stripCodeBlocks(content);
  let m: RegExpExecArray | null;
  WIKI_LINK_RE.lastIndex = 0;
  while ((m = WIKI_LINK_RE.exec(stripped)) !== null) {
    const target = m[1].trim();
    if (!target) continue;
    links.push({
      target,
      alias: m[2] !== undefined ? m[2].trim() : undefined,
      raw: m[0],
    });
  }
  return links;
}

const TAG_RE = /(^|[\s(>"'\-])(#[A-Za-z0-9][A-Za-z0-9_-]*)/g;

/**
 * Extract #tags from markdown content. Code blocks are skipped. A tag must
 * start with a letter/digit right after # and may contain letters, digits,
 * underscores and hyphens.
 */
export function parseTags(content: string): string[] {
  const tags = new Set<string>();
  const stripped = stripCodeBlocks(content);
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(stripped)) !== null) {
    tags.add(m[2].slice(1).toLowerCase());
  }
  return [...tags];
}

function stripCodeBlocks(content: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const line of content.split('\n')) {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (!inCode) out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  title: string;
  /** Total links (in + out) — for node sizing. */
  linkCount: number;
  tags: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Knowledge index computed over a NoteStore. All queries are derived from
 * note content at call time — no separate index to keep in sync.
 */
export class KnowledgeIndex {
  constructor(private readonly store: NoteStore) {}

  /** All notes, for internal scans. */
  private all(): Note[] {
    return this.store.list();
  }

  /** Outgoing wiki-links of a note. */
  outgoingLinks(note: Note): WikiLink[] {
    return parseWikiLinks(note.content);
  }

  /** Tags of a note. */
  tagsOf(note: Note): string[] {
    return parseTags(note.content);
  }

  /**
   * Resolve a wiki-link target to a note by title (case-insensitive,
   * trimmed). Returns undefined for dangling links.
   */
  resolveLink(target: string): Note | undefined {
    const want = target.trim().toLowerCase();
    return this.all().find((n) => n.title.trim().toLowerCase() === want);
  }

  /** Notes that link TO the given note id (via resolvable wiki-links). */
  backlinks(id: string): Note[] {
    const note = this.store.get(id);
    if (!note) return [];
    const titleKey = note.title.trim().toLowerCase();
    return this.all().filter(
      (n) =>
        n.id !== id &&
        this.outgoingLinks(n).some((l) => l.target.trim().toLowerCase() === titleKey),
    );
  }

  /** Full graph: one node per note, one edge per resolvable wiki-link. */
  graph(): KnowledgeGraph {
    const notes = this.all();
    const byTitle = new Map<string, Note>();
    for (const n of notes) byTitle.set(n.title.trim().toLowerCase(), n);

    const edges: GraphEdge[] = [];
    const linkCounts = new Map<string, number>();
    for (const n of notes) {
      for (const link of this.outgoingLinks(n)) {
        const target = byTitle.get(link.target.trim().toLowerCase());
        if (target && target.id !== n.id) {
          edges.push({ from: n.id, to: target.id });
          linkCounts.set(n.id, (linkCounts.get(n.id) ?? 0) + 1);
          linkCounts.set(target.id, (linkCounts.get(target.id) ?? 0) + 1);
        }
      }
    }
    const nodes: GraphNode[] = notes.map((n) => ({
      id: n.id,
      title: n.title,
      linkCount: linkCounts.get(n.id) ?? 0,
      tags: this.tagsOf(n),
    }));
    return { nodes, edges };
  }

  /** tag → note ids (tags lowercased). */
  tags(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const n of this.all()) {
      for (const t of this.tagsOf(n)) {
        (map[t] ??= []).push(n.id);
      }
    }
    return map;
  }

  /** Notes carrying a given tag (case-insensitive). */
  notesByTag(tag: string): Note[] {
    const want = tag.trim().toLowerCase().replace(/^#/, '');
    return this.all().filter((n) => this.tagsOf(n).includes(want));
  }

  /**
   * Full-text search over titles + content. Title matches rank first,
   * then by recency. Empty query → [].
   */
  search(q: string): Note[] {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const terms = query.split(/\s+/);
    const scored: Array<{ note: Note; score: number }> = [];
    for (const n of this.all()) {
      const title = n.title.toLowerCase();
      const content = n.content.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 10;
        if (content.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ note: n, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
      .map((s) => s.note);
  }

  /**
   * Get-or-create the daily note for a date (YYYY-MM-DD, defaults to today
   * in the server's local timezone). Title IS the date string.
   */
  dailyNote(dateStr?: string): Note {
    const date = dateStr ?? localDateString(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`invalid date "${date}" — expected YYYY-MM-DD`);
    }
    const existing = this.all().find((n) => n.title === date);
    if (existing) return existing;
    return this.store.create({
      title: date,
      content: `# ${date}\n\n`,
    });
  }

  /**
   * Rename a note and propagate the rename to wiki-links in other notes:
   * `[[Old]]` → `[[New]]`, `[[Old|alias]]` → `[[New|alias]]`.
   * Returns the renamed note plus ids of notes whose links were updated.
   */
  rename(id: string, newTitle: string): { note: Note; updatedNoteIds: string[] } {
    const note = this.store.get(id);
    if (!note) throw new Error(`unknown note: ${id}`);
    const oldTitle = note.title;
    const renamed = this.store.update(id, { title: newTitle });

    const updatedNoteIds: string[] = [];
    if (oldTitle.trim().toLowerCase() !== newTitle.trim().toLowerCase()) {
      const pattern = new RegExp(
        `\\[\\[${escapeRegExp(oldTitle.trim())}(\\|[^\\][\\n]*)?\\]\\]`,
        'g',
      );
      for (const other of this.all()) {
        if (other.id === id) continue;
        if (!pattern.test(other.content)) {
          pattern.lastIndex = 0;
          continue;
        }
        pattern.lastIndex = 0;
        const next = other.content.replace(pattern, (_m, alias: string | undefined) =>
          alias ? `[[${newTitle.trim()}${alias}]]` : `[[${newTitle.trim()}]]`,
        );
        this.store.update(other.id, { content: next });
        updatedNoteIds.push(other.id);
      }
    }
    return { note: renamed, updatedNoteIds };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface KnowledgeDeps {
  dataDir: string;
  /** Optional pre-built store (tests inject their own dataDir normally). */
  noteStore?: NoteStore;
}

/**
 * Register Obsidian-style knowledge routes. MUST be called before
 * registerNotesRoutes on the same router so /graph, /search, /tags and
 * /daily are not swallowed by /:id.
 */
export function registerKnowledgeRoutes(router: Router, deps: KnowledgeDeps): void {
  const store = deps.noteStore ?? new NoteStore(deps.dataDir);
  const index = new KnowledgeIndex(store);

  const ok = (res: Response, payload: unknown): void => {
    res.json(payload);
  };
  const fail = (res: Response, err: unknown, fallback: string, notFound = false): void => {
    const message = err instanceof Error ? err.message : fallback;
    res.status(notFound ? 404 : 500).json({ error: message });
  };

  // GET /graph → { nodes, edges }
  router.get('/graph', (_req: Request, res: Response) => {
    try {
      ok(res, index.graph());
    } catch (err) {
      fail(res, err, 'failed to build graph');
    }
  });

  // GET /tags → { tags: Record<tag, noteIds> }
  router.get('/tags', (_req: Request, res: Response) => {
    try {
      ok(res, { tags: index.tags() });
    } catch (err) {
      fail(res, err, 'failed to list tags');
    }
  });

  // GET /search?q= → Note[]
  router.get('/search', (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      ok(res, index.search(q));
    } catch (err) {
      fail(res, err, 'failed to search notes');
    }
  });

  // POST /daily → get-or-create today's note
  router.post('/daily', (_req: Request, res: Response) => {
    try {
      ok(res, index.dailyNote());
    } catch (err) {
      fail(res, err, 'failed to open daily note');
    }
  });

  // GET /daily/:date → get-or-create note for YYYY-MM-DD
  router.get('/daily/:date', (req: Request, res: Response) => {
    try {
      ok(res, index.dailyNote(req.params.date));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to open daily note';
      res.status(message.startsWith('invalid date') ? 400 : 500).json({ error: message });
    }
  });

  // GET /:id/backlinks → Note[]
  router.get('/:id/backlinks', (req: Request, res: Response) => {
    try {
      const note = store.get(req.params.id);
      if (!note) {
        fail(res, new Error(`unknown note: ${req.params.id}`), '', true);
        return;
      }
      ok(res, index.backlinks(req.params.id));
    } catch (err) {
      fail(res, err, 'failed to list backlinks');
    }
  });

  // POST /:id/rename → { title } → { note, updatedNoteIds }
  router.post('/:id/rename', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { title?: unknown };
      if (typeof body.title !== 'string' || !body.title.trim()) {
        res.status(400).json({ error: 'rename requires a non-empty "title"' });
        return;
      }
      const result = index.rename(req.params.id, body.title);
      ok(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to rename note';
      res.status(message.startsWith('unknown note') ? 404 : 500).json({ error: message });
    }
  });
}

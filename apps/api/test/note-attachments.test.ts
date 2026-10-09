// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/note-attachments.ts (feature interconnection):
// attach/detach/list, thread vs bot-wide scoping for context injection,
// context block assembly with budgets, and the HTTP routes. Temp data dirs
// only; no paid APIs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NoteAttachmentStore,
  buildAttachmentContext,
  registerNoteAttachmentRoutes,
} from '../src/note-attachments.js';
import { NoteStore } from '../src/notes.js';
import { PageStore } from '../src/pages.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mvp-noteattach-'));
}

describe('NoteAttachmentStore', () => {
  let dir: string;
  let store: NoteAttachmentStore;
  let noteId: string;
  let pageId: string;

  beforeEach(() => {
    dir = freshDataDir();
    noteId = new NoteStore(dir).create({ title: 'Shopping', content: 'buy milk' }).id;
    pageId = new PageStore(dir).create({ title: 'Roadmap', content: 'q3 plans' }).id;
    store = new NoteAttachmentStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('attaches notes/pages to a thread or bot-wide, idempotently', () => {
    const a1 = store.attach({ kind: 'note', refId: noteId, sessionId: 'sess-1' });
    expect(a1.title).toBe('Shopping');
    expect(a1.sessionId).toBe('sess-1');
    expect(a1.botId).toBeUndefined();
    // re-attaching the same ref+scope returns the existing row
    const a1b = store.attach({ kind: 'note', refId: noteId, sessionId: 'sess-1' });
    expect(a1b.id).toBe(a1.id);
    // same ref, different scope → new row
    const a2 = store.attach({ kind: 'note', refId: noteId, botId: 'bot-1' });
    expect(a2.id).not.toBe(a1.id);
    const a3 = store.attach({ kind: 'page', refId: pageId, botId: 'bot-1' });
    expect(a3.title).toBe('Roadmap');
    expect(store.listAll()).toHaveLength(3);
  });

  it('rejects bad input and unknown refs', () => {
    expect(() => store.attach({ kind: 'note', refId: 'missing', sessionId: 's' })).toThrow(/unknown note/);
    expect(() => store.attach({ kind: 'page', refId: 'missing', botId: 'b' })).toThrow(/unknown page/);
    expect(() => store.attach({ kind: 'note', refId: noteId })).toThrow(/botId \/ sessionId/);
    expect(() => store.attach({ kind: 'weird' as never, refId: noteId, botId: 'b' })).toThrow(/kind must be/);
  });

  it('forTurn returns thread + bot-wide attachments, not other sessions', () => {
    store.attach({ kind: 'note', refId: noteId, sessionId: 'sess-1' });
    store.attach({ kind: 'note', refId: noteId, sessionId: 'sess-2' });
    store.attach({ kind: 'page', refId: pageId, botId: 'bot-1' });
    store.attach({ kind: 'page', refId: pageId, botId: 'bot-9' });
    const got = store.forTurn('bot-1', 'sess-1').map((a) => a.id);
    expect(got).toHaveLength(2); // sess-1 thread + bot-1 wide
  });

  it('detach removes; unknown id returns false', () => {
    const a = store.attach({ kind: 'note', refId: noteId, botId: 'bot-1' });
    expect(store.detach(a.id)).toBe(true);
    expect(store.detach(a.id)).toBe(false);
    expect(store.listAll()).toHaveLength(0);
  });
});

describe('buildAttachmentContext', () => {
  let dir: string;
  let store: NoteAttachmentStore;

  beforeEach(() => {
    dir = freshDataDir();
    store = new NoteAttachmentStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when nothing is attached', () => {
    expect(buildAttachmentContext(store, 'bot-1', 'sess-1')).toBeUndefined();
  });

  it('assembles attached note content with a trusted-context header', () => {
    const noteId = new NoteStore(dir).create({ title: 'Plan', content: 'do the thing' }).id;
    store.attach({ kind: 'note', refId: noteId, sessionId: 'sess-1' });
    const ctx = buildAttachmentContext(store, 'bot-1', 'sess-1');
    expect(ctx).toContain('# Attached reference material');
    expect(ctx).toContain('## Plan (note)');
    expect(ctx).toContain('do the thing');
    // other session sees nothing
    expect(buildAttachmentContext(store, 'bot-1', 'sess-2')).toBeUndefined();
  });

  it('skips refs deleted after attaching and respects the total budget', () => {
    const ns = new NoteStore(dir);
    // Per-item budget is 4000 chars; four 10000-char notes exceed the
    // 12000 total budget, so exactly three sections survive.
    const ids = [0, 1, 2, 3].map((i) =>
      ns.create({ title: `Big${i}`, content: 'x'.repeat(10_000) }).id,
    );
    for (const id of ids) store.attach({ kind: 'note', refId: id, botId: 'bot-1' });
    const ctx = buildAttachmentContext(store, 'bot-1', 'any-session')!;
    const sections = [...ctx.matchAll(/## (Big\d) \(note\)/g)].map((m) => m[1]);
    // Four 10000-char notes cannot all fit in the 12000-char total budget
    // (each is truncated to ~4000 chars + suffix), so some are dropped.
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.length).toBeLessThan(4);
    // deleted ref → skipped silently (one fewer section, deleted title gone)
    ns.remove(ids[0]!);
    const ctx2 = buildAttachmentContext(store, 'bot-1', 'any-session')!;
    const sections2 = [...ctx2.matchAll(/## (Big\d) \(note\)/g)].map((m) => m[1]);
    expect(sections2).not.toContain('Big0');
    expect(sections2.length).toBeLessThanOrEqual(3);
  });
});

describe('note-attachment routes', () => {
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let dir: string;
  let noteId: string;

  beforeEach(async () => {
    dir = freshDataDir();
    noteId = new NoteStore(dir).create({ title: 'Routed note', content: 'route body' }).id;
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerNoteAttachmentRoutes(router, { dataDir: dir });
    app.use('/api/note-attachments', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as typeof server;
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/note-attachments`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  it('POST creates, GET lists/filters, DELETE removes', async () => {
    const created = await api('POST', '/', { kind: 'note', refId: noteId, sessionId: 'sess-9' });
    expect(created.status).toBe(201);
    expect(created.json.ok).toBe(true);
    const id = created.json.attachment.id as string;

    const all = await api('GET', '/');
    expect(all.json.attachments).toHaveLength(1);
    const filtered = await api('GET', '/?sessionId=sess-9');
    expect(filtered.json.attachments).toHaveLength(1);
    const other = await api('GET', '/?sessionId=nope');
    expect(other.json.attachments).toHaveLength(0);

    const del = await api('DELETE', `/${id}`);
    expect(del.status).toBe(200);
    const del2 = await api('DELETE', `/${id}`);
    expect(del2.status).toBe(404);
  });

  it('POST validates kind/ref/scope', async () => {
    expect((await api('POST', '/', { kind: 'note', refId: 'missing', botId: 'b' })).status).toBe(400);
    expect((await api('POST', '/', { kind: 'note', refId: noteId })).status).toBe(400);
    expect((await api('POST', '/', { kind: 'nope', refId: noteId, botId: 'b' })).status).toBe(400);
  });
});

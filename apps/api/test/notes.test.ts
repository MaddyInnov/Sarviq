// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoteStore, registerNotesRoutes } from '../src/notes.js';

describe('NoteStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notes-'));
  });

  it('starts empty and persists across instances', () => {
    const store = new NoteStore(dir);
    expect(store.list()).toEqual([]);
    const note = store.create({ title: '  First note  ', content: '# hello' });
    expect(note.title).toBe('First note'); // trimmed
    expect(note.id).toBeTruthy();
    expect(note.content).toBe('# hello');

    const reopened = new NoteStore(dir);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get(note.id)).toMatchObject({ id: note.id, title: 'First note' });
  });

  it('orders list by updatedAt desc and updates the timestamp on update', () => {
    const store = new NoteStore(dir);
    const a = store.create({ title: 'a' });
    const b = store.create({ title: 'b' });
    expect(store.list().map((n) => n.id)).toEqual([b.id, a.id]);

    const updated = store.update(a.id, { content: 'changed' });
    expect(updated.content).toBe('changed');
    expect(updated.title).toBe('a'); // untouched
    expect(updated.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(store.list()[0].id).toBe(a.id);
  });

  it('removes notes and throws on unknown ids', () => {
    const store = new NoteStore(dir);
    const n = store.create({ title: 'gone' });
    store.remove(n.id);
    expect(store.get(n.id)).toBeUndefined();
    expect(() => store.update(n.id, { title: 'x' })).toThrow(/unknown note/);
    expect(() => store.remove(n.id)).toThrow(/unknown note/);
  });

  it('validates title and content', () => {
    const store = new NoteStore(dir);
    expect(() => store.create({ title: '   ' })).toThrow(/title/);
    expect(() => store.create({ title: 'x'.repeat(201) })).toThrow(/title/);
    const n = store.create({ title: 'ok' });
    expect(() => store.update(n.id, { title: '' })).toThrow(/title/);
    expect(() => store.update(n.id, { content: 42 as unknown as string })).toThrow(/content/);
  });

  it('skips corrupt rows on load instead of crashing', () => {
    const store = new NoteStore(dir);
    store.create({ title: 'real' });
    const good = store.list();
    expect(good).toHaveLength(1);
    // Hand-corrupt the file with extra junk rows.
    writeFileSync(store.path(), JSON.stringify([...good, { junk: true }, null]), 'utf8');
    expect(new NoteStore(dir).list()).toHaveLength(1);
  });
});

describe('notes router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'notes-routes-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerNotesRoutes(router, { dataDir: dir });
    app.use('/api/notes', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/notes`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path = '', body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('CRUDs a note end to end', async () => {
    expect((await api('GET')).json).toEqual([]);

    const created = await api('POST', '', { title: 'Todo', content: '- [ ] ship' });
    expect(created.status).toBe(201);
    const note = created.json as { id: string; title: string; content: string };
    expect(note.title).toBe('Todo');

    const fetched = await api('GET', `/${note.id}`);
    expect(fetched.status).toBe(200);
    expect((fetched.json as { id: string }).id).toBe(note.id);

    const updated = await api('PUT', `/${note.id}`, { title: 'Todo!', content: 'done' });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ title: 'Todo!', content: 'done' });

    const deleted = await api('DELETE', `/${note.id}`);
    expect(deleted.status).toBe(200);
    expect((await api('GET', `/${note.id}`)).status).toBe(404);
  });

  it('returns 400 for missing/blank titles and 404 for unknown ids', async () => {
    expect((await api('POST', '', { content: 'no title' })).status).toBe(400);
    expect((await api('POST', '', { title: '  ' })).status).toBe(400);
    expect((await api('GET', '/nope')).status).toBe(404);
    expect((await api('PUT', '/nope', { title: 'x' })).status).toBe(404);
    expect((await api('DELETE', '/nope')).status).toBe(404);
  });
});

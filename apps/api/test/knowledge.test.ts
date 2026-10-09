// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoteStore, registerNotesRoutes } from '../src/notes.js';
import {
  KnowledgeIndex,
  parseTags,
  parseWikiLinks,
  registerKnowledgeRoutes,
} from '../src/knowledge.js';

describe('parseWikiLinks', () => {
  it('parses [[Title]] and [[Title|alias]]', () => {
    const links = parseWikiLinks('See [[My Note]] and [[Other|display text]].');
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ target: 'My Note', alias: undefined });
    expect(links[1]).toMatchObject({ target: 'Other', alias: 'display text' });
  });

  it('ignores links inside fenced code blocks', () => {
    const links = parseWikiLinks('```\n[[Not A Link]]\n```\nReal [[Yes]]');
    expect(links.map((l) => l.target)).toEqual(['Yes']);
  });

  it('trims targets and skips empties', () => {
    const links = parseWikiLinks('[[  Spaced  ]] [[ ]]');
    expect(links.map((l) => l.target)).toEqual(['Spaced']);
  });
});

describe('parseTags', () => {
  it('extracts #tags case-insensitively deduplicated', () => {
    expect(parseTags('Hello #World, this is #test-case and #World again'))
      .toEqual(expect.arrayContaining(['world', 'test-case']));
    expect(parseTags('#World #world')).toEqual(['world']);
  });

  it('ignores tags inside code blocks', () => {
    expect(parseTags('```\n#notatag\n```\n#real')).toEqual(['real']);
  });
});

describe('KnowledgeIndex', () => {
  let dir: string;
  let store: NoteStore;
  let index: KnowledgeIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-'));
    store = new NoteStore(dir);
    index = new KnowledgeIndex(store);
  });

  it('computes backlinks via resolvable wiki-links', () => {
    const a = store.create({ title: 'Alpha' });
    const b = store.create({ title: 'Beta', content: 'Links to [[Alpha]] here.' });
    store.create({ title: 'Gamma', content: 'No links.' });
    // Dangling link doesn't create a backlink.
    store.create({ title: 'Delta', content: 'Links to [[Missing]].' });

    const backs = index.backlinks(a.id);
    expect(backs.map((n) => n.id)).toEqual([b.id]);
  });

  it('builds a graph with nodes and edges', () => {
    const a = store.create({ title: 'Alpha' });
    const b = store.create({ title: 'Beta', content: '→ [[Alpha]]' });
    const graph = index.graph();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ from: b.id, to: a.id }]);
    const nodeA = graph.nodes.find((n) => n.id === a.id)!;
    expect(nodeA.linkCount).toBe(1);
  });

  it('groups tags to note ids', () => {
    const a = store.create({ title: 'A', content: '#work #urgent' });
    const b = store.create({ title: 'B', content: '#work' });
    const tags = index.tags();
    expect(tags.work).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(tags.urgent).toEqual([a.id]);
    expect(index.notesByTag('work')).toHaveLength(2);
    expect(index.notesByTag('#WORK')).toHaveLength(2);
  });

  it('searches titles first, then content', () => {
    const a = store.create({ title: 'Banana bread', content: 'nothing' });
    const b = store.create({ title: 'Other', content: 'mentions banana here' });
    const results = index.search('banana');
    expect(results.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(index.search('   ')).toEqual([]);
  });

  it('dailyNote is idempotent for the same date', () => {
    const first = index.dailyNote('2026-10-09');
    const second = index.dailyNote('2026-10-09');
    expect(first.id).toBe(second.id);
    expect(first.title).toBe('2026-10-09');
    expect(() => index.dailyNote('not-a-date')).toThrow(/invalid date/);
  });

  it('rename propagates wiki-links in other notes', () => {
    const a = store.create({ title: 'Old Title' });
    const b = store.create({ title: 'B', content: 'See [[Old Title]] and [[Old Title|click]].' });
    const c = store.create({ title: 'C', content: 'Unrelated [[Other]].' });

    const { note, updatedNoteIds } = index.rename(a.id, 'New Title');
    expect(note.title).toBe('New Title');
    expect(updatedNoteIds).toEqual([b.id]);

    const bAfter = store.get(b.id)!;
    expect(bAfter.content).toBe('See [[New Title]] and [[New Title|click]].');
    expect(store.get(c.id)!.content).toBe('Unrelated [[Other]].');
  });
});

describe('knowledge routes', () => {
  let dir: string;
  let app: express.Express;
  let server: ReturnType<express.Express['listen']>;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-routes-'));
    const store = new NoteStore(dir);
    app = express();
    app.use(express.json());
    const router = express.Router();
    registerKnowledgeRoutes(router, { dataDir: dir, noteStore: store });
    registerNotesRoutes(router, { dataDir: dir, noteStore: store });
    app.use('/api/notes', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notes`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

  const get = (path: string) =>
    fetch(`${base}${path}`).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

  it('serves /graph, /tags, /search before /:id swallows them', async () => {
    const a = await post('/', { title: 'Hub', content: '#home' });
    await post('/', { title: 'Spoke', content: '→ [[Hub]] #home' });

    const graph = await get('/graph');
    expect(graph.status).toBe(200);
    expect(graph.json.nodes).toHaveLength(2);
    expect(graph.json.edges).toHaveLength(1);

    const tags = await get('/tags');
    expect(tags.status).toBe(200);
    expect(Object.keys(tags.json.tags)).toContain('home');

    const search = await get('/search?q=hub');
    expect(search.status).toBe(200);
    expect(search.json[0].id).toBe(a.json.id);

    // Tag filter on the list route still works.
    const filtered = await get('/?tag=home');
    expect(filtered.status).toBe(200);
    expect(filtered.json).toHaveLength(2);
  });

  it('handles daily notes and backlinks and rename', async () => {
    const a = await post('/', { title: 'Target' });
    await post('/', { title: 'Referrer', content: 'see [[Target]]' });

    const backs = await get(`/${a.json.id}/backlinks`);
    expect(backs.status).toBe(200);
    expect(backs.json).toHaveLength(1);

    const daily = await post('/daily');
    expect(daily.status).toBe(200);
    expect(daily.json.title).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const dailyGet = await get(`/daily/${daily.json.title}`);
    expect(dailyGet.json.id).toBe(daily.json.id);

    const renamed = await post(`/${a.json.id}/rename`, { title: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.json.note.title).toBe('Renamed');
    expect(renamed.json.updatedNoteIds).toHaveLength(1);

    const missing = await get('/nope/backlinks');
    expect(missing.status).toBe(404);
  });
});

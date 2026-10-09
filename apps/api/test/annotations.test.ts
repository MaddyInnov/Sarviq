// SPDX-License-Identifier: Apache-2.0
// Tests for external-assistant annotations (apps/api/src/annotations.ts):
// - AnnotationStore: append-only (no update/remove surface), pending by
//   default, one-way review, persistence, validation, corrupt-row skip.
// - REST routes: the review queue (GET /pending) and approve/dismiss flow.
// All storage is a temp-dir JSON file; no network, no secrets.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnnotationStore, registerAnnotationRoutes } from '../src/annotations.js';

describe('AnnotationStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'annotations-'));
  });

  it('starts empty and persists across instances', () => {
    const store = new AnnotationStore(dir);
    expect(store.list()).toEqual([]);
    expect(store.listPending()).toEqual([]);

    const a = store.append({ kind: 'note', content: 'saw a spike', source: 'agent-1' });
    expect(a.record).toBe('annotation'); // explicitly labeled
    expect(a.status).toBe('pending'); // never trusted on write
    expect(a.kind).toBe('note');
    expect(a.source).toBe('agent-1');
    expect(a.id).toBeTruthy();

    const reopened = new AnnotationStore(dir);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get(a.id)).toMatchObject({ id: a.id, status: 'pending' });
  });

  it('is append-only: no update or remove methods exist', () => {
    const store = new AnnotationStore(dir) as unknown as Record<string, unknown>;
    expect(store.update).toBeUndefined();
    expect(store.remove).toBeUndefined();
    expect(store.delete).toBeUndefined();
  });

  it('reviews pending items exactly once (one-way)', () => {
    const store = new AnnotationStore(dir);
    const a = store.append({ kind: 'report', content: 'daily summary' });
    expect(a.source).toBe('external-assistant'); // default source

    const approved = store.review(a.id, 'approve', 'ashutosh');
    expect(approved.status).toBe('approved');
    expect(approved.reviewedBy).toBe('ashutosh');
    expect(approved.reviewedAt).toBeGreaterThanOrEqual(a.createdAt);

    // Already reviewed → cannot go back to pending or flip.
    expect(() => store.review(a.id, 'dismiss')).toThrow(/already approved/);

    const b = store.append({ kind: 'promise', content: 'will retry' });
    expect(store.review(b.id, 'dismiss').status).toBe('dismissed');

    // Pending queue is empty; list still shows everything (audit trail kept).
    expect(store.listPending()).toEqual([]);
    expect(store.list()).toHaveLength(2);
  });

  it('orders pending oldest-first and list newest-first', () => {
    const store = new AnnotationStore(dir);
    const first = store.append({ kind: 'note', content: 'one' });
    const second = store.append({ kind: 'note', content: 'two' });
    expect(store.listPending().map((r) => r.id)).toEqual([first.id, second.id]);
    expect(store.list().map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('rejects unknown ids and bad decisions', () => {
    const store = new AnnotationStore(dir);
    expect(() => store.review('nope', 'approve')).toThrow(/unknown annotation/);
    const a = store.append({ kind: 'note', content: 'x' });
    expect(() => store.review(a.id, 'maybe' as 'approve')).toThrow(/approve.*dismiss/);
  });

  it('validates kind, content, and source', () => {
    const store = new AnnotationStore(dir);
    expect(() => store.append({ kind: 'fact', content: 'x' })).toThrow(/kind/);
    expect(() => store.append({ kind: 'note', content: '   ' })).toThrow(/content/);
    expect(() => store.append({ kind: 'note', content: 'x'.repeat(10001) })).toThrow(/10000/);
    expect(() => store.append({ kind: 'note', content: 'x', source: '  ' })).toThrow(/source/);
  });

  it('skips corrupt rows on load instead of crashing', () => {
    const store = new AnnotationStore(dir);
    store.append({ kind: 'note', content: 'real' });
    const good = store.list();
    expect(good).toHaveLength(1);
    writeFileSync(store.path(), JSON.stringify([...good, { junk: true }, null, { record: 'annotation', kind: 'bogus' }]), 'utf8');
    const reopened = new AnnotationStore(dir);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0].id).toBe(good[0].id);
  });
});

describe('annotations router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'annotations-routes-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAnnotationRoutes(router, { dataDir: dir });
    app.use('/api/annotations', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/annotations`;
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

  it('runs the full review flow: append → pending queue → approve → dismissed stays out', async () => {
    expect(((await api('GET')).json as { annotations: unknown[] }).annotations).toEqual([]);

    const created = await api('POST', '', { kind: 'report', content: 'queue is healthy', source: 'agent-7' });
    expect(created.status).toBe(201);
    const item = created.json as { id: string; record: string; status: string };
    expect(item.record).toBe('annotation');
    expect(item.status).toBe('pending');

    // Pending queue shows it.
    const pending = (await api('GET', '/pending')).json as { annotations: { id: string }[] };
    expect(pending.annotations.map((a) => a.id)).toEqual([item.id]);

    // Approve it.
    const reviewed = await api('POST', `/${item.id}/review`, { decision: 'approve', reviewer: 'ashutosh' });
    expect(reviewed.status).toBe(200);
    expect((reviewed.json as { status: string }).status).toBe('approved');

    // Queue is empty; the item is still retrievable with its verdict.
    expect(((await api('GET', '/pending')).json as { annotations: unknown[] }).annotations).toEqual([]);
    const fetched = (await api('GET', `/${item.id}`)).json as { status: string; reviewedBy: string };
    expect(fetched).toMatchObject({ status: 'approved', reviewedBy: 'ashutosh' });
  });

  it('supports dismiss and rejects re-review', async () => {
    const created = (await api('POST', '', { kind: 'promise', content: 'will not retry' })).json as { id: string };
    const dismissed = await api('POST', `/${created.id}/review`, { decision: 'dismiss' });
    expect(dismissed.status).toBe(200);
    expect((dismissed.json as { status: string }).status).toBe('dismissed');
    // Re-review is one-way: 400.
    expect((await api('POST', `/${created.id}/review`, { decision: 'approve' })).status).toBe(400);
  });

  it('returns 400 for bad input and 404 for unknown ids', async () => {
    expect((await api('POST', '', { kind: 'bogus', content: 'x' })).status).toBe(400);
    expect((await api('POST', '', { kind: 'note', content: '' })).status).toBe(400);
    expect((await api('GET', '/nope')).status).toBe(404);
    expect((await api('POST', '/nope/review', { decision: 'approve' })).status).toBe(404);
    const created = (await api('POST', '', { kind: 'note', content: 'x' })).json as { id: string };
    expect((await api('POST', `/${created.id}/review`, { decision: 'later' })).status).toBe(400);
  });

  it('keeps annotations out of the pending queue once reviewed (separate sections)', async () => {
    const a = (await api('POST', '', { kind: 'note', content: 'one' })).json as { id: string };
    const b = (await api('POST', '', { kind: 'note', content: 'two' })).json as { id: string };
    await api('POST', `/${a.id}/review`, { decision: 'approve' });
    const pending = (await api('GET', '/pending')).json as { annotations: { id: string }[] };
    expect(pending.annotations.map((x) => x.id)).toEqual([b.id]);
    const all = (await api('GET')).json as { annotations: { id: string; status: string }[] };
    expect(all.annotations).toHaveLength(2);
    expect(all.annotations.every((x) => x.id && x.status)).toBe(true);
  });
});

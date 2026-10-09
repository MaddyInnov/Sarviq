// SPDX-License-Identifier: Apache-2.0
// Tests for the Omni rolling-summary backend (Omni panel: "Where am I
// right now?"). Localhost HTTP + temp SQLite files only — no external
// network (Ollama enhancement stays off; rollups are deterministic).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OmniCollector,
  OmniScheduler,
  OmniStore,
  classifyAuditAction,
  isMajorKind,
  type OmniAuditLike,
  type OmniCollectorSources,
} from '../src/omni.js';
import { registerOmniRoutes } from '../src/omni-routes.js';

const DAY = 24 * 60 * 60 * 1000;
// Fixed "now": 2026-10-09T12:00:00Z (a Friday) — day/week boundaries are
// deterministic in UTC.
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const YESTERDAY = NOW - DAY;
const TEN_DAYS_AGO = NOW - 10 * DAY;

function newStore(): { store: OmniStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'omni-test-'));
  return { store: new OmniStore(dir), dir };
}

function recentItem(store: OmniStore, n: number, ts: number, kind = 'tool') {
  return store.upsertItem({
    layer: 'recent',
    title: `Activity ${n}`,
    detail: `detail ${n}`,
    ts,
    kind,
    source: 'audit',
    sourceKey: `audit:test-${n}`,
  });
}

describe('classifyAuditAction (layer assignment rules)', () => {
  it('routes high-priority events to attention', () => {
    expect(classifyAuditAction('tool.denied')).toBe('attention');
    expect(classifyAuditAction('turn.budget_cap')).toBe('attention');
    expect(classifyAuditAction('message.send_blocked')).toBe('attention');
  });
  it('routes major events to milestones', () => {
    expect(classifyAuditAction('briefing.generated')).toBe('milestones');
  });
  it('routes everyday activity to recent', () => {
    expect(classifyAuditAction('message.sent')).toBe('recent');
    expect(classifyAuditAction('tool.executed')).toBe('recent');
    expect(classifyAuditAction('oauth.connected')).toBe('recent');
    expect(classifyAuditAction('mcp.tool_scopes_updated')).toBe('recent');
  });
  it('skips noise and events owned by other collectors', () => {
    expect(classifyAuditAction('workflow.succeeded')).toBeNull(); // runs collector
    expect(classifyAuditAction('tool.approval_requested')).toBeNull(); // approvals collector
    expect(classifyAuditAction('something.unknown')).toBeNull();
    expect(classifyAuditAction('')).toBeNull();
  });
});

describe('isMajorKind', () => {
  it('marks major events for milestone promotion', () => {
    expect(isMajorKind('workflow-failed')).toBe(true);
    expect(isMajorKind('deployment')).toBe(true);
    expect(isMajorKind('briefing-generated')).toBe(true);
    expect(isMajorKind('tool')).toBe(false);
    expect(isMajorKind('workflow-completed')).toBe(false);
    expect(isMajorKind(undefined)).toBe(false);
  });
});

describe('OmniStore items + pins', () => {
  it('upserts idempotently by sourceKey', () => {
    const { store } = newStore();
    const a = store.upsertItem({
      layer: 'recent', title: 'T1', ts: NOW, kind: 'tool', source: 'audit', sourceKey: 'audit:1',
    });
    const b = store.upsertItem({
      layer: 'recent', title: 'T1 updated', ts: NOW, kind: 'tool', source: 'audit', sourceKey: 'audit:1',
    });
    expect(a.id).toBe(b.id);
    expect(store.listItems('recent')).toHaveLength(1);
    expect(store.getItem(a.id)?.title).toBe('T1 updated');
  });

  it('pin/unpin round-trips and pins[] spans layers', () => {
    const { store } = newStore();
    const recent = store.upsertItem({ layer: 'recent', title: 'R', ts: NOW, sourceKey: 's:r' });
    const milestone = store.upsertItem({ layer: 'milestones', title: 'M', ts: NOW, sourceKey: 's:m' });
    expect(store.setPinned(recent.id, true)).toBe(true);
    expect(store.setPinned(milestone.id, true)).toBe(true);
    expect(store.listPins().map((i) => i.id).sort()).toEqual([recent.id, milestone.id].sort());
    const summary = store.getSummary();
    expect(summary.pins.map((p) => p.title).sort()).toEqual(['M', 'R']);
    expect(store.setPinned(recent.id, false)).toBe(true);
    expect(store.listPins()).toHaveLength(1);
    expect(store.setPinned('nope', true)).toBe(false);
  });
});

describe('rollupNightly: Recent → Period compression', () => {
  it('compresses yesterday items into highlights and empties recent', async () => {
    const { store } = newStore();
    recentItem(store, 1, YESTERDAY, 'tool');
    recentItem(store, 2, YESTERDAY, 'tool');
    recentItem(store, 3, YESTERDAY, 'message');
    recentItem(store, 4, YESTERDAY, 'message');
    recentItem(store, 5, YESTERDAY, 'oauth');
    // Today's items must survive.
    recentItem(store, 6, NOW, 'tool');

    const stats = await store.rollupNightly(NOW);
    expect(stats.rolledUp).toBe(5);
    expect(stats.produced).toBeGreaterThan(0);
    expect(stats.produced).toBeLessThanOrEqual(5);
    expect(store.listItems('recent')).toHaveLength(1);
    const period = store.listItems('period');
    expect(period).toHaveLength(stats.produced);
    for (const h of period) {
      expect(h.title.length).toBeGreaterThan(0);
      expect(h.kind?.startsWith('rollup:')).toBe(true);
    }
  });

  it('is a no-op with no stale items', async () => {
    const { store } = newStore();
    recentItem(store, 1, NOW, 'tool');
    const stats = await store.rollupNightly(NOW);
    expect(stats).toEqual({ rolledUp: 0, produced: 0 });
    expect(store.listItems('recent')).toHaveLength(1);
  });

  it('is deterministic (same titles across runs)', async () => {
    const mk = () => {
      const { store } = newStore();
      for (let n = 1; n <= 8; n++) recentItem(store, n, YESTERDAY, n % 2 === 0 ? 'tool' : 'message');
      return store;
    };
    const a = mk();
    const b = mk();
    await a.rollupNightly(NOW);
    await b.rollupNightly(NOW);
    const titles = (s: OmniStore) => s.listItems('period').map((i) => i.title).sort();
    expect(titles(a)).toEqual(titles(b));
  });

  it('caps highlights at 5 with an overflow bucket', async () => {
    const { store } = newStore();
    const kinds = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'];
    kinds.forEach((k, i) => recentItem(store, i + 1, YESTERDAY, k));
    const stats = await store.rollupNightly(NOW);
    expect(stats.produced).toBeLessThanOrEqual(5);
    expect(stats.rolledUp).toBe(7);
    expect(store.listItems('recent')).toHaveLength(0);
  });

  it('demotes stale attention items to recent and never rolls up pins', async () => {
    const { store } = newStore();
    const stale = store.upsertItem({
      layer: 'attention', title: 'Stale alert', ts: YESTERDAY, kind: 'tool.denied', sourceKey: 'audit:stale',
    });
    const pinned = recentItem(store, 99, YESTERDAY, 'tool');
    store.setPinned(pinned.id, true);

    await store.rollupNightly(NOW);
    expect(store.getItem(stale.id)?.layer).toBe('recent');
    expect(store.getItem(pinned.id)?.layer).toBe('recent');
    expect(store.getItem(pinned.id)?.pinned).toBe(true);
  });
});

describe('rollupWeekly: Period → Milestones', () => {
  it('promotes only major events, drops the rest', () => {
    const { store } = newStore();
    store.upsertItem({
      layer: 'period', title: 'Deploy', ts: TEN_DAYS_AGO, kind: 'deployment', source: 'rollup', sourceKey: 'rollup:d1',
    });
    store.upsertItem({
      layer: 'period', title: 'Chatter', ts: TEN_DAYS_AGO, kind: 'tool', source: 'rollup', sourceKey: 'rollup:d2',
    });
    // This week's period items must survive.
    store.upsertItem({
      layer: 'period', title: 'Fresh', ts: NOW, kind: 'tool', source: 'rollup', sourceKey: 'rollup:d3',
    });

    const stats = store.rollupWeekly(NOW);
    expect(stats.rolledUp).toBe(2);
    expect(stats.produced).toBe(1);
    const milestones = store.listItems('milestones').map((i) => i.title);
    expect(milestones).toContain('Deploy');
    expect(milestones).not.toContain('Chatter');
    expect(store.listItems('period').map((i) => i.title)).toEqual(['Fresh']);
  });

  it('never rolls up pinned period items', () => {
    const { store } = newStore();
    const pinned = store.upsertItem({
      layer: 'period', title: 'Keep me', ts: TEN_DAYS_AGO, kind: 'tool', source: 'rollup', sourceKey: 'rollup:p1',
    });
    store.setPinned(pinned.id, true);
    store.rollupWeekly(NOW);
    expect(store.getItem(pinned.id)).toBeDefined();
  });
});

describe('versions: snapshot, time-travel, retention', () => {
  it('snapshots layers and retrieves them back (time-travel)', () => {
    const { store } = newStore();
    recentItem(store, 1, NOW, 'tool');
    const v = store.createVersion('before lunch', 'manual');
    expect(v.label).toBe('before lunch');
    recentItem(store, 2, NOW, 'tool');

    const back = store.getVersionSummary(v.id);
    expect(back).toBeDefined();
    expect(back!.recent).toHaveLength(1);
    expect(back!.recent[0].title).toBe('Activity 1');
    // Live summary moved on.
    expect(store.getSummary().recent).toHaveLength(2);
    // The snapshot still carries the current versions list.
    expect(back!.versions.some((x) => x.id === v.id)).toBe(true);
  });

  it('returns undefined for unknown versions', () => {
    const { store } = newStore();
    expect(store.getVersionSummary('nope')).toBeUndefined();
    expect(store.getVersion('nope')).toBeUndefined();
  });

  it('lists versions newest-first', () => {
    const { store } = newStore();
    const v1 = store.createVersion('one', 'manual');
    const v2 = store.createVersion('two', 'manual');
    const ids = store.listVersions().map((v) => v.id);
    expect(ids[0]).toBe(v2.id);
    expect(ids[1]).toBe(v1.id);
  });

  it('prunes retention: 30 daily, 12 weekly, 30 manual', () => {
    const { store } = newStore();
    for (let i = 0; i < 35; i++) store.createVersion(`daily ${i}`, 'daily');
    for (let i = 0; i < 15; i++) store.createVersion(`weekly ${i}`, 'weekly');
    for (let i = 0; i < 33; i++) store.createVersion(`manual ${i}`, 'manual');
    const versions = store.listVersions();
    const byG = (g: string) => versions.filter((v) => v.granularity === g).length;
    expect(byG('daily')).toBe(30);
    expect(byG('weekly')).toBe(12);
    expect(byG('manual')).toBe(30);
  });
});

describe('OmniScheduler', () => {
  const emptySources: OmniCollectorSources = {
    listApprovals: () => [],
    listAudit: () => [],
    listRuns: () => [],
  };

  it('runs the nightly rollup once per UTC day', async () => {
    const { store } = newStore();
    const collector = new OmniCollector(store, emptySources);
    const scheduler = new OmniScheduler(store, { collector });
    recentItem(store, 1, YESTERDAY, 'tool');

    await scheduler.tick(NOW);
    expect(store.getKv('rollup.lastNightly')).toBe('2026-10-09');
    expect(store.listItems('period')).toHaveLength(1);

    // Same day: no re-rollup.
    await scheduler.tick(NOW + 60_000);
    expect(store.listItems('period')).toHaveLength(1);

    // Next day: marker advances (nothing left to roll up).
    await scheduler.tick(NOW + DAY);
    expect(store.getKv('rollup.lastNightly')).toBe('2026-10-10');
  });

  it('runs the weekly rollup on Mondays only', async () => {
    const { store } = newStore();
    const scheduler = new OmniScheduler(store, { collector: new OmniCollector(store, emptySources) });
    const monday = Date.UTC(2026, 9, 12, 12, 0, 0); // a Monday
    store.upsertItem({
      layer: 'period', title: 'Old deploy', ts: TEN_DAYS_AGO, kind: 'deployment', sourceKey: 'rollup:old',
    });

    await scheduler.tick(NOW); // Friday — weekly must not run
    expect(store.getKv('rollup.lastWeekly')).toBeUndefined();
    expect(store.listItems('period')).toHaveLength(1);

    await scheduler.tick(monday);
    expect(store.getKv('rollup.lastWeekly')).toBeDefined();
    expect(store.listItems('period')).toHaveLength(0);
    expect(store.listItems('milestones').map((i) => i.title)).toContain('Old deploy');
  });

  it('collector failures never break the tick', async () => {
    const { store } = newStore();
    const bad: OmniCollectorSources = {
      listApprovals: () => { throw new Error('boom'); },
      listAudit: () => [],
      listRuns: () => [],
    };
    const scheduler = new OmniScheduler(store, { collector: new OmniCollector(store, bad) });
    await expect(scheduler.tick(NOW)).resolves.toBeUndefined();
  });
});

describe('OmniCollector', () => {
  function fakes(over: Partial<OmniCollectorSources> = {}): OmniCollectorSources {
    return {
      listApprovals: () => [],
      listAudit: (_limit: number, _offset: number) => [],
      listRuns: () => [],
      ...over,
    };
  }

  it('ingests pending approvals into attention and clears resolved ones', async () => {
    const { store } = newStore();
    let pending = [{ id: 'a1', toolName: 'shell.exec', botId: 'b1', ts: NOW }];
    const collector = new OmniCollector(store, fakes({ listApprovals: () => pending }));

    await collector.collect();
    let attention = store.listItems('attention');
    expect(attention).toHaveLength(1);
    expect(attention[0].title).toContain('shell.exec');

    // Idempotent: no duplicates on re-collect.
    await collector.collect();
    expect(store.listItems('attention')).toHaveLength(1);

    // Resolved approvals lose their attention slot.
    pending = [];
    await collector.collect();
    expect(store.listItems('attention')).toHaveLength(0);
  });

  it('tracks workflow runs: active → attention, failed → milestone', async () => {
    const { store } = newStore();
    let runs = [{ id: 'r1', workflowId: 'wf-deploy', status: 'running', createdAt: NOW, updatedAt: NOW }];
    const collector = new OmniCollector(store, fakes({ listRuns: () => runs }));

    await collector.collect();
    expect(store.listItems('attention').map((i) => i.kind)).toContain('workflow-running');

    runs = [{ id: 'r1', workflowId: 'wf-deploy', status: 'failed', createdAt: NOW, updatedAt: NOW + 1000 }];
    await collector.collect();
    const milestones = store.listItems('milestones');
    expect(milestones.map((i) => i.title)).toContain('Workflow failed: wf-deploy');
    // Active slot dropped; failed recorded once.
    expect(store.listItems('attention')).toHaveLength(0);
    await collector.collect();
    expect(store.listItems('milestones')).toHaveLength(1);
  });

  it('ingests audit entries incrementally via watermark', async () => {
    const { store } = newStore();
    const entries: OmniAuditLike[] = [
      { id: 1, ts: NOW, actor: 'agent', action: 'message.sent' },
      { id: 2, ts: NOW, actor: 'agent', action: 'tool.executed', toolName: 'web.search' },
      { id: 3, ts: NOW, actor: 'agent', action: 'tool.denied', toolName: 'shell.exec' },
    ];
    const collector = new OmniCollector(
      store,
      fakes({ listAudit: (limit, offset) => entries.slice(offset, offset + limit) }),
    );

    const stats = await collector.collect();
    expect(stats.audit).toBe(3);
    expect(store.listItems('recent')).toHaveLength(2);
    expect(store.listItems('attention').map((i) => i.kind)).toContain('tool.denied');

    // Second pass: nothing new (watermark held).
    const stats2 = await collector.collect();
    expect(stats2.audit).toBe(0);
    expect(store.listItems('recent')).toHaveLength(2);

    // New entry arrives → picked up.
    entries.push({ id: 4, ts: NOW, actor: 'agent', action: 'oauth.connected' });
    const stats3 = await collector.collect();
    expect(stats3.audit).toBe(1);
  });
});

describe('omni routes', () => {
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let store: OmniStore;
  let collector: OmniCollector;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-routes-'));
    store = new OmniStore(dir);
    collector = new OmniCollector(store, { listApprovals: () => [], listAudit: () => [], listRuns: () => [] });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerOmniRoutes(router, { omni: store, collector });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    store.close();
  });

  it('GET /api/summary/omni → 404 on an empty store', async () => {
    const res = await fetch(`${baseUrl}/api/summary/omni`);
    expect(res.status).toBe(404);
  });

  it('GET /api/summary/omni → full contract shape once populated', async () => {
    const item = store.upsertItem({ layer: 'attention', title: 'A', ts: NOW, sourceKey: 's:a' });
    store.setPinned(item.id, true);
    const res = await fetch(`${baseUrl}/api/summary/omni`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    for (const key of ['attention', 'recent', 'period', 'milestones', 'pins', 'versions']) {
      expect(Array.isArray(body[key])).toBe(true);
    }
    expect((body.attention as Array<{ title: string }>)[0].title).toBe('A');
    expect((body.pins as Array<{ title: string }>)[0].title).toBe('A');
  });

  it('?version=<id> time-travels; unknown version → 404', async () => {
    store.upsertItem({ layer: 'recent', title: 'Old', ts: NOW, sourceKey: 's:old' });
    const v = store.createVersion('v1', 'manual');
    store.upsertItem({ layer: 'recent', title: 'New', ts: NOW, sourceKey: 's:new' });

    const res = await fetch(`${baseUrl}/api/summary/omni?version=${v.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recent: Array<{ title: string }> };
    expect(body.recent.map((i) => i.title)).toEqual(['Old']);

    const missing = await fetch(`${baseUrl}/api/summary/omni?version=nope`);
    expect(missing.status).toBe(404);
  });

  it('GET /api/summary/omni/versions lists newest-first', async () => {
    store.createVersion('first', 'manual');
    store.createVersion('second', 'manual');
    const res = await fetch(`${baseUrl}/api/summary/omni/versions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; createdAt: number; label?: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].label).toBe('second');
    expect(body[0].createdAt).toBeGreaterThanOrEqual(body[1].createdAt);
  });

  it('POST /api/summary/omni/pins round-trips pin/unpin', async () => {
    const item = store.upsertItem({ layer: 'recent', title: 'Pin me', ts: NOW, sourceKey: 's:pin' });

    let res = await fetch(`${baseUrl}/api/summary/omni/pins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, action: 'pin' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(store.listPins()).toHaveLength(1);

    res = await fetch(`${baseUrl}/api/summary/omni/pins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, action: 'unpin' }),
    });
    expect(res.status).toBe(200);
    expect(store.listPins()).toHaveLength(0);

    // Validation: bad action → 400, unknown item → 404.
    res = await fetch(`${baseUrl}/api/summary/omni/pins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id, action: 'fold' }),
    });
    expect(res.status).toBe(400);
    res = await fetch(`${baseUrl}/api/summary/omni/pins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'nope', action: 'pin' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/summary/omni/snapshot creates a version', async () => {
    store.upsertItem({ layer: 'recent', title: 'R', ts: NOW, sourceKey: 's:r' });
    const res = await fetch(`${baseUrl}/api/summary/omni/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'checkpoint' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: { id: string; createdAt: number; label?: string } };
    expect(body.ok).toBe(true);
    expect(body.version.label).toBe('checkpoint');
    expect(store.getVersion(body.version.id)).toBeDefined();
  });

  it('POST /api/summary/omni/rollup triggers compression', async () => {
    recentItem(store, 1, YESTERDAY, 'tool');
    recentItem(store, 2, YESTERDAY, 'tool');
    const res = await fetch(`${baseUrl}/api/summary/omni/rollup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'nightly' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      kind: string;
      stats: { nightly: { rolledUp: number; produced: number } };
    };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('nightly');
    expect(body.stats.nightly.rolledUp).toBe(2);
    expect(body.stats.nightly.produced).toBe(1);

    const bad = await fetch(`${baseUrl}/api/summary/omni/rollup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'fortnightly' }),
    });
    expect(bad.status).toBe(400);
  });
});

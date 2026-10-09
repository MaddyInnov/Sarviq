// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/briefing.ts + briefing-routes.ts: generation from
// fixture events, the Ollama->template fallback, history pagination,
// retention pruning, config validation, and the scheduled tick.
// Temp data dirs only; OLLAMA_HOST points at an unreachable port so the
// template fallback is deterministic.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { RunHealthStore } from '@mvp/run-health';
import {
  BriefingScheduler,
  BriefingStore,
  generateBriefing,
  templateSummary,
  validateBriefingTime,
} from '../src/briefing.js';
import { registerBriefingRoutes } from '../src/briefing-routes.js';
import { CalendarEventStore } from '../src/tasks.js';

const UNREACHABLE_OLLAMA = 'http://127.0.0.1:1';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'briefing-api-'));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function todayAt(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

describe('briefing routes', () => {
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let dir: string;
  let governance: GovernanceGateway;
  let runHealth: RunHealthStore;
  let prevOllamaHost: string | undefined;

  beforeEach(async () => {
    prevOllamaHost = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = UNREACHABLE_OLLAMA; // template fallback, deterministic
    dir = freshDataDir();
    governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
    runHealth = new RunHealthStore(join(dir, 'run-health.db'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerBriefingRoutes(router, { dataDir: dir, governance, runHealth });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    if (prevOllamaHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = prevOllamaHost;
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  function seedFixtures(): void {
    governance.audit('approval.created', {
      actor: 'bot-1',
      sessionId: 's1',
      toolName: 'shell.exec',
      decision: 'require-approval',
    });
    governance.audit('tool.evaluate', { actor: 'bot-2', sessionId: 's2', toolName: 'file.read' });
    governance.requestApproval(
      'file.write',
      { path: '/tmp/x' },
      { sessionId: 's1', botId: 'bot-1', actor: 'user' },
    );
    new CalendarEventStore(dir).create({
      title: 'Standup',
      startsAt: todayAt(10, 0),
      endsAt: todayAt(10, 30),
    });
  }

  it('GET /api/briefing is 404 when no briefing exists', async () => {
    const res = await api('GET', '/briefing');
    expect(res.status).toBe(404);
    expect(res.json.error).toMatch(/no briefing/i);
  });

  it('POST /api/briefing/generate assembles all sections with the template summary', async () => {
    seedFixtures();
    const res = await api('POST', '/briefing/generate');
    expect(res.status).toBe(201);
    const b = res.json;
    expect(typeof b.generatedAt).toBe('number');

    expect(b.overnight).toHaveLength(2);
    expect(b.overnight[0].kind).toBe('audit');
    expect(b.overnight.map((i: any) => i.title)).toContain('approval created');

    expect(b.approvals).toHaveLength(1);
    expect(b.approvals[0].title).toBe('Approval needed: file.write');
    expect(b.approvals[0].kind).toBe('approval');

    expect(b.calendar).toHaveLength(1);
    expect(b.calendar[0].title).toBe('Standup');
    expect(b.calendar[0].kind).toBe('calendar');
    expect(b.calendar[0].detail).toContain('10:00');

    expect(b.regressions).toEqual([]);

    // Deterministic template fallback (Ollama unreachable).
    expect(b.summary).toContain('Overnight: 2 events across 2 bots.');
    expect(b.summary).toContain('1 approval pending');
    expect(b.summary).toContain('Today: 1 calendar event scheduled.');
    expect(b.summary).toContain('No health regressions in the last 7 days.');
  });

  it('overnight window starts at the previous briefing', async () => {
    seedFixtures();
    await api('POST', '/briefing/generate');
    governance.audit('tool.evaluate', { actor: 'bot-3', sessionId: 's3', toolName: 'web.fetch' });
    const res = await api('POST', '/briefing/generate');
    expect(res.status).toBe(201);
    expect(res.json.overnight).toHaveLength(1);
    expect(res.json.overnight[0].detail).toContain('bot-3');
  });

  it('GET /api/briefing returns the latest briefing payload', async () => {
    seedFixtures();
    await api('POST', '/briefing/generate');
    const res = await api('GET', '/briefing');
    expect(res.status).toBe(200);
    expect(res.json.approvals).toHaveLength(1);
    expect(typeof res.json.summary).toBe('string');
    // Contract shape: no store internals leak into the payload.
    expect(res.json.id).toBeUndefined();
    expect(res.json.kind).toBeUndefined();
  });

  it('GET /api/briefing/history paginates newest-first', async () => {
    seedFixtures();
    await api('POST', '/briefing/generate');
    await api('POST', '/briefing/generate');
    const p1 = await api('GET', '/briefing/history?page=1&limit=1');
    expect(p1.status).toBe(200);
    expect(p1.json.total).toBe(2);
    expect(p1.json.items).toHaveLength(1);
    expect(p1.json.items[0].kind).toBe('manual');
    expect(typeof p1.json.items[0].summary).toBe('string');
    const p2 = await api('GET', '/briefing/history?page=2&limit=1');
    expect(p2.json.items).toHaveLength(1);
    expect(p2.json.page).toBe(2);
    // Clamp: limit > 100 is capped, not an error.
    const capped = await api('GET', '/briefing/history?limit=500');
    expect(capped.json.limit).toBe(100);
  });

  it('briefing config round-trips with validation', async () => {
    const initial = await api('GET', '/briefing/config');
    expect(initial.json).toEqual({ briefingTime: '07:00', briefingEnabled: true });

    const badTime = await api('PUT', '/briefing/config', { briefingTime: '25:00' });
    expect(badTime.status).toBe(400);
    const badFlag = await api('PUT', '/briefing/config', { briefingEnabled: 'yes' });
    expect(badFlag.status).toBe(400);

    const ok = await api('PUT', '/briefing/config', { briefingTime: '08:30', briefingEnabled: false });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ briefingTime: '08:30', briefingEnabled: false });
    const reread = await api('GET', '/briefing/config');
    expect(reread.json).toEqual({ briefingTime: '08:30', briefingEnabled: false });
  });
});

describe('BriefingStore', () => {
  it('prunes briefings older than 30 days', () => {
    const dir = freshDataDir();
    const store = new BriefingStore(dir);
    // Insert the old row with raw SQL: saveBriefing() prunes on write by
    // design, so a store-level insert can never hold an expired row.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(join(dir, 'briefing.db'));
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO briefings (id, generated_at, kind, payload) VALUES (?, ?, ?, ?)')
      .run('old-1', old, 'manual', JSON.stringify({ generatedAt: old, overnight: [], calendar: [], approvals: [] }));
    db.close();
    expect(store.list(1, 10).total).toBe(1);
    expect(store.prune()).toBe(1);
    expect(store.latest()).toBeUndefined();
    expect(store.list(1, 10).total).toBe(0);
  });

  it('keeps recent briefings on prune', () => {
    const dir = freshDataDir();
    const store = new BriefingStore(dir);
    store.saveBriefing('scheduled', { generatedAt: Date.now(), overnight: [], calendar: [], approvals: [] });
    expect(store.prune()).toBe(0);
    expect(store.latest()?.kind).toBe('scheduled');
  });

  it('lists newest-first with pagination', () => {
    const dir = freshDataDir();
    const store = new BriefingStore(dir);
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      store.saveBriefing('manual', {
        generatedAt: base - i * 1000,
        overnight: [],
        calendar: [],
        approvals: [],
        summary: `summary-${i}`,
      });
    }
    const p1 = store.list(1, 2);
    expect(p1.total).toBe(3);
    expect(p1.items.map((i) => i.summary)).toEqual(['summary-0', 'summary-1']);
    const p2 = store.list(2, 2);
    expect(p2.items.map((i) => i.summary)).toEqual(['summary-2']);
  });

  it('validateBriefingTime accepts HH:MM and rejects the rest', () => {
    expect(() => validateBriefingTime('07:00')).not.toThrow();
    expect(() => validateBriefingTime('23:59')).not.toThrow();
    expect(() => validateBriefingTime('7:00')).toThrow();
    expect(() => validateBriefingTime('24:00')).toThrow();
    expect(() => validateBriefingTime('07:60')).toThrow();
    expect(() => validateBriefingTime('')).toThrow();
    expect(() => validateBriefingTime(700)).toThrow();
  });
});

describe('summary', () => {
  it('templateSummary renders 4 deterministic sentences', () => {
    const s = templateSummary({
      overnightCount: 2,
      botCount: 2,
      approvalCount: 1,
      approvalTitles: ['Approval needed: file.write'],
      eventCount: 1,
      regressionCount: 0,
    });
    expect(s.split('. ').length).toBe(4);
    expect(s).toContain('Overnight: 2 events across 2 bots.');
    expect(s).toContain('1 approval pending: Approval needed: file.write.');
    expect(s).toContain('Today: 1 calendar event scheduled.');
    expect(s).toContain('No health regressions in the last 7 days.');
  });

  it('generateBriefing uses the injected summarizer when provided', async () => {
    const dir = freshDataDir();
    const governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
    const runHealth = new RunHealthStore(join(dir, 'run-health.db'));
    const briefing = await generateBriefing({
      governance,
      runHealth,
      dataDir: dir,
      summarize: async () => 'LLM-crafted narrative summary.',
    });
    expect(briefing.summary).toBe('LLM-crafted narrative summary.');
  });

  it('generateBriefing falls back to the template when the summarizer fails', async () => {
    const dir = freshDataDir();
    const governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
    const runHealth = new RunHealthStore(join(dir, 'run-health.db'));
    const briefing = await generateBriefing({
      governance,
      runHealth,
      dataDir: dir,
      summarize: async () => {
        throw new Error('boom');
      },
    });
    expect(briefing.summary).toContain('Overnight: 0 events across 0 bots.');
  });
});

describe('BriefingScheduler', () => {
  let prevOllamaHost: string | undefined;

  beforeEach(() => {
    prevOllamaHost = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = UNREACHABLE_OLLAMA;
  });

  afterEach(() => {
    if (prevOllamaHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = prevOllamaHost;
  });

  function setup() {
    const dir = freshDataDir();
    const governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
    const runHealth = new RunHealthStore(join(dir, 'run-health.db'));
    const scheduler = new BriefingScheduler({ dataDir: dir, governance, runHealth });
    const store = new BriefingStore(dir); // same sqlite file, config visibility shared
    return { dir, governance, runHealth, scheduler, store };
  }

  it('generates once at the configured time and dedups within the day', async () => {
    const { scheduler, store } = setup();
    const now = new Date();
    store.setConfig({ briefingTime: hhmm(now), briefingEnabled: true });
    await scheduler.tick(now);
    expect(store.list(1, 10).total).toBe(1);
    expect(store.latest()?.kind).toBe('scheduled');
    // Same minute again: no duplicate.
    await scheduler.tick(now);
    expect(store.list(1, 10).total).toBe(1);
  });

  it('does not fire outside the configured minute', async () => {
    const { scheduler, store } = setup();
    const now = new Date();
    const later = new Date(now.getTime() + 2 * 60 * 1000);
    store.setConfig({ briefingTime: hhmm(later), briefingEnabled: true });
    await scheduler.tick(now);
    expect(store.list(1, 10).total).toBe(0);
  });

  it('does not fire when disabled', async () => {
    const { scheduler, store } = setup();
    const now = new Date();
    store.setConfig({ briefingTime: hhmm(now), briefingEnabled: false });
    await scheduler.tick(now);
    expect(store.list(1, 10).total).toBe(0);
  });
});

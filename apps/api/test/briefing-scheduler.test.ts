// SPDX-License-Identifier: Apache-2.0
// BriefingScheduler: the scheduled daily digest actually fires at the
// configured local time, persists a 'scheduled' briefing, and dedups to one
// briefing per day. No network, no paid APIs — the summarize step is
// injected (deterministic template would also do).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GovernanceGateway } from '@mvp/governance';
import type { RunHealthStore } from '@mvp/run-health';
import { BriefingScheduler, BriefingStore } from '../src/briefing.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'briefing-sched-'));
  dirs.push(d);
  return d;
}

function stubDeps(dataDir: string) {
  const governance = {
    listAudit: () => [],
    listApprovals: () => [],
  } as unknown as GovernanceGateway;
  const runHealth = {
    listScopes: () => [],
  } as unknown as RunHealthStore;
  return {
    dataDir,
    governance,
    runHealth,
    summarize: async () => 'Test digest summary.',
  };
}

/** Local-time date at HH:MM on an arbitrary day. */
function atTime(h: number, m: number): Date {
  return new Date(2026, 9, 9, h, m, 0);
}

describe('BriefingScheduler.tick', () => {
  it('generates and persists a scheduled briefing at the configured time', async () => {
    const dataDir = freshDir();
    const sched = new BriefingScheduler(stubDeps(dataDir));
    await sched.tick(atTime(7, 0));

    const store = new BriefingStore(dataDir);
    const latest = store.latest();
    expect(latest).toBeDefined();
    expect(latest!.kind).toBe('scheduled');
    expect(latest!.payload.summary).toBe('Test digest summary.');
    expect(store.getSetting('last_fired_day')).toBe('2026-10-09');
  });

  it('dedups: one briefing per day even across repeated ticks', async () => {
    const dataDir = freshDir();
    const sched = new BriefingScheduler(stubDeps(dataDir));
    await sched.tick(atTime(7, 0));
    await sched.tick(atTime(7, 0));
    await sched.tick(atTime(7, 1));

    const store = new BriefingStore(dataDir);
    expect(store.list(1, 10).total).toBe(1);
  });

  it('fires again the next day', async () => {
    const dataDir = freshDir();
    const sched = new BriefingScheduler(stubDeps(dataDir));
    await sched.tick(atTime(7, 0));
    await sched.tick(new Date(2026, 9, 10, 7, 0, 0));

    const store = new BriefingStore(dataDir);
    expect(store.list(1, 10).total).toBe(2);
  });

  it('does nothing outside the configured minute', async () => {
    const dataDir = freshDir();
    const sched = new BriefingScheduler(stubDeps(dataDir));
    await sched.tick(atTime(8, 30));

    const store = new BriefingStore(dataDir);
    expect(store.latest()).toBeUndefined();
  });

  it('does nothing when disabled', async () => {
    const dataDir = freshDir();
    const store = new BriefingStore(dataDir);
    store.setConfig({ briefingEnabled: false });
    const sched = new BriefingScheduler(stubDeps(dataDir));
    await sched.tick(atTime(7, 0));
    expect(store.latest()).toBeUndefined();
  });

  it('honors a custom briefing time', async () => {
    const dataDir = freshDir();
    const store = new BriefingStore(dataDir);
    store.setConfig({ briefingTime: '21:45' });
    const sched = new BriefingScheduler(stubDeps(dataDir));
    await sched.tick(atTime(7, 0));
    expect(store.latest()).toBeUndefined();
    await sched.tick(atTime(21, 45));
    expect(store.latest()?.kind).toBe('scheduled');
  });

  it('never throws into the caller (bad governance store)', async () => {
    const dataDir = freshDir();
    const deps = stubDeps(dataDir);
    deps.governance = {
      listAudit: () => {
        throw new Error('boom');
      },
      listApprovals: () => [],
    } as unknown as GovernanceGateway;
    const sched = new BriefingScheduler(deps);
    await expect(sched.tick(atTime(7, 0))).resolves.toBeUndefined();
  });
});

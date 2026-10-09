// SPDX-License-Identifier: Apache-2.0
// Condition watchers (Muse parity, P3-E): "tell me when X becomes true".
//
// A watcher is a named condition the host evaluates on a schedule (cron
// trigger `muse-watcher:<id>`, same pattern as reminders) or on demand.
// evaluateWatcher() is EDGE-TRIGGERED: an event is recorded only on a
// false→true transition, so a persistently-true condition pages exactly once
// until it goes false again. The host supplies the domain check function;
// this module owns persistence, edge detection, and trigger registration.
//
// This is the missing "watchers" leg of crons/hooks/reminders/watchers:
// crons start workflows, thread-scheduler wakes threads, webhooks are inbound
// event hooks, reminders fire once at a time — watchers fire when a *state*
// changes.

import { randomUUID } from 'node:crypto';
import type { Trigger, TriggerStore } from '@mvp/workflows';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

/** Workflow-id prefix the host dispatch layer matches to route evaluations. */
export const WATCHER_WORKFLOW_PREFIX = 'muse-watcher:';

export interface Watcher {
  id: string;
  name: string;
  description: string;
  /** 5-field cron for scheduled evaluation; '' = manual/on-demand only. */
  cron: string;
  enabled: boolean;
  /** Last observed condition; null when never evaluated. */
  lastCondition: boolean | null;
  lastCheckedAt: number | null;
  lastFiredAt: number | null;
  createdAt: number;
}

export interface WatcherEvent {
  id: string;
  watcherId: string;
  detail: string;
  createdAt: number;
}

interface WatcherRow {
  id: string;
  name: string;
  description: string;
  cron: string;
  enabled: number;
  last_condition: number | null;
  last_checked_at: number | null;
  last_fired_at: number | null;
  created_at: number;
}

interface WatcherEventRow {
  id: string;
  watcher_id: string;
  detail: string;
  created_at: number;
}

function rowToWatcher(row: WatcherRow): Watcher {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cron: row.cron,
    enabled: row.enabled === 1,
    lastCondition: row.last_condition === null ? null : row.last_condition === 1,
    lastCheckedAt: row.last_checked_at,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
  };
}

function rowToEvent(row: WatcherEventRow): WatcherEvent {
  return {
    id: row.id,
    watcherId: row.watcher_id,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

export class WatcherStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: { name: string; description?: string; cron?: string }): Watcher {
    const name = (input.name ?? '').trim();
    if (!name) throw new ValidationError('watcher "name" must be a non-empty string');
    if (name.length > 200) throw new ValidationError('watcher "name" must be at most 200 characters');
    const description = (input.description ?? '').trim().slice(0, 2000);
    const cron = (input.cron ?? '').trim();
    if (cron && !CRON_RE.test(cron)) {
      throw new ValidationError('watcher "cron" must be a 5-field expression: "minute hour dom month dow"');
    }
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_watchers
           (id, name, description, cron, enabled, last_condition, last_checked_at, last_fired_at, created_at)
         VALUES (?, ?, ?, ?, 1, NULL, NULL, NULL, ?)`,
      )
      .run(id, name, description, cron, now);
    return this.get(id);
  }

  get(id: string): Watcher {
    const row = this.mdb.db
      .prepare(
        `SELECT id, name, description, cron, enabled, last_condition, last_checked_at, last_fired_at, created_at
         FROM mm_watchers WHERE id = ?`,
      )
      .get(id) as unknown as WatcherRow | undefined;
    if (!row) throw new NotFoundError(`unknown watcher: ${id}`);
    return rowToWatcher(row);
  }

  list(): Watcher[] {
    const rows = this.mdb.db
      .prepare(
        `SELECT id, name, description, cron, enabled, last_condition, last_checked_at, last_fired_at, created_at
         FROM mm_watchers ORDER BY created_at DESC`,
      )
      .all() as unknown as unknown as WatcherRow[];
    return rows.map(rowToWatcher);
  }

  setEnabled(id: string, enabled: boolean): Watcher {
    this.get(id);
    this.mdb.db.prepare('UPDATE mm_watchers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    this.mdb.db.prepare('DELETE FROM mm_watcher_events WHERE watcher_id = ?').run(id);
    this.mdb.db.prepare('DELETE FROM mm_watchers WHERE id = ?').run(id);
  }

  events(watcherId: string, limit = 50): WatcherEvent[] {
    this.get(watcherId);
    const rows = this.mdb.db
      .prepare(
        `SELECT id, watcher_id, detail, created_at FROM mm_watcher_events
         WHERE watcher_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(watcherId, Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as unknown as WatcherEventRow[];
    return rows.map(rowToEvent);
  }
}

export interface WatcherObservation {
  /** Current value of the watched condition. */
  condition: boolean;
  /** Human-readable detail recorded with the event when it fires. */
  detail?: string;
}

export interface WatcherEvaluation {
  watcher: Watcher;
  /** True only when this evaluation caused a NEW event (edge trigger). */
  fired: boolean;
  event: WatcherEvent | null;
}

/**
 * Evaluate a watcher with a fresh observation. Records an event ONLY on a
 * false→true transition (first-ever true also fires). Disabled watchers are
 * never evaluated — throws ValidationError.
 */
export function evaluateWatcher(
  store: WatcherStore,
  mdb: ModuleDb,
  watcherId: string,
  observation: WatcherObservation,
): WatcherEvaluation {
  const watcher = store.get(watcherId);
  if (!watcher.enabled) {
    throw new ValidationError('watcher is disabled');
  }
  const now = Date.now();
  const prev = watcher.lastCondition;
  const curr = observation.condition === true;
  // Edge trigger: fire when the condition becomes true and was not true
  // before (null = never evaluated counts as "not true").
  const fired = curr && prev !== true;
  let event: WatcherEvent | null = null;
  if (fired) {
    const id = randomUUID();
    const detail = (observation.detail ?? '').trim().slice(0, 1000);
    mdb.db
      .prepare('INSERT INTO mm_watcher_events (id, watcher_id, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(id, watcherId, detail, now);
    event = { id, watcherId, detail, createdAt: now };
  }
  mdb.db
    .prepare(
      `UPDATE mm_watchers
       SET last_condition = ?, last_checked_at = ?${fired ? ', last_fired_at = ?' : ''}
       WHERE id = ?`,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .run(...(fired ? [curr ? 1 : 0, now, now, watcherId] : [curr ? 1 : 0, now, watcherId]) as any);
  return { watcher: store.get(watcherId), fired, event };
}

/**
 * Create a watcher and register its evaluation trigger in the existing
 * TriggerStore (same pattern as reminders). The trigger's workflowId is
 * `muse-watcher:<watcherId>`; the host's dispatch layer matches the prefix
 * and runs its domain check, then calls evaluateWatcher().
 */
export function scheduleWatcher(
  store: WatcherStore,
  triggerStore: TriggerStore,
  input: { name: string; description?: string; cron: string },
): { watcher: Watcher; trigger: Trigger } {
  if (!input.cron || !CRON_RE.test(input.cron.trim())) {
    throw new ValidationError('scheduleWatcher requires a valid 5-field cron expression');
  }
  const watcher = store.create(input);
  const trigger = triggerStore.create({
    workflowId: `${WATCHER_WORKFLOW_PREFIX}${watcher.id}`,
    kind: 'cron',
    cron: input.cron.trim(),
    enabled: true,
  });
  return { watcher, trigger };
}

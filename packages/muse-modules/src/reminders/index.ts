// SPDX-License-Identifier: Apache-2.0
// User-facing reminders (Muse parity): create / list / cancel / done, plus a
// due-checker and firing integration with the existing workflows trigger
// mechanism (imported from @mvp/workflows — triggers.ts is never edited).
//
// Firing design: scheduleReminder() persists the reminder AND registers a cron
// Trigger whose workflowId is `muse-reminder:<reminderId>` and whose cron
// expression fires at the reminder's due minute. The host Scheduler already
// ticks cron triggers with per-(trigger, minute) idempotency; the host's
// dispatch layer checks the `muse-reminder:` prefix BEFORE delegating to
// WorkflowRunner and calls fireReminder(id) instead — reusing trigger
// persistence, cron parsing/validation, and the scheduler loop for firing.
// fireReminder() itself is idempotent, so even a double dispatch is safe.
// The due-checker (listDue) covers hosts that prefer polling.

import { randomUUID } from 'node:crypto';
import type { Trigger, TriggerStore } from '@mvp/workflows';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type ReminderChannel = 'push' | 'email' | 'sms';
export type ReminderStatus = 'scheduled' | 'fired' | 'done' | 'cancelled';

/** Workflow-id prefix the host dispatch layer matches to route firing. */
export const REMINDER_WORKFLOW_PREFIX = 'muse-reminder:';

export interface Reminder {
  id: string;
  title: string;
  /** Due time, ms epoch. */
  when: number;
  channel: ReminderChannel;
  status: ReminderStatus;
  firedAt: number | null;
  createdAt: number;
}

interface ReminderRow {
  id: string;
  title: string;
  when_ts: number;
  channel: string;
  status: string;
  fired_at: number | null;
  created_at: number;
}

function rowToReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    title: row.title,
    when: row.when_ts,
    channel: row.channel as ReminderChannel,
    status: row.status as ReminderStatus,
    firedAt: row.fired_at,
    createdAt: row.created_at,
  };
}

const CHANNELS: ReadonlySet<string> = new Set(['push', 'email', 'sms']);

export class ReminderStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: { title: string; when: number; channel: ReminderChannel }): Reminder {
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('reminder "title" must be a non-empty string');
    if (title.length > 200) throw new ValidationError('reminder "title" must be at most 200 characters');
    if (!Number.isFinite(input.when) || input.when <= 0) {
      throw new ValidationError('reminder "when" must be a ms-epoch timestamp');
    }
    if (!CHANNELS.has(input.channel)) {
      throw new ValidationError(`reminder "channel" must be one of: push, email, sms`);
    }
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_reminders (id, title, when_ts, channel, status, fired_at, created_at)
         VALUES (?, ?, ?, ?, 'scheduled', NULL, ?)`,
      )
      .run(id, title, Math.floor(input.when), input.channel, now);
    return this.get(id);
  }

  get(id: string): Reminder {
    const row = this.mdb.db
      .prepare('SELECT id, title, when_ts, channel, status, fired_at, created_at FROM mm_reminders WHERE id = ?')
      .get(id) as ReminderRow | undefined;
    if (!row) throw new NotFoundError(`unknown reminder: ${id}`);
    return rowToReminder(row);
  }

  list(status?: ReminderStatus): Reminder[] {
    const rows = (
      status
        ? this.mdb.db
            .prepare(
              'SELECT id, title, when_ts, channel, status, fired_at, created_at FROM mm_reminders WHERE status = ? ORDER BY when_ts ASC',
            )
            .all(status)
        : this.mdb.db
            .prepare(
              'SELECT id, title, when_ts, channel, status, fired_at, created_at FROM mm_reminders ORDER BY when_ts ASC',
            )
            .all()
    ) as unknown as ReminderRow[];
    return rows.map(rowToReminder);
  }

  /** Due-checker: scheduled reminders whose due time has passed. */
  listDue(now: number = Date.now()): Reminder[] {
    const rows = this.mdb.db
      .prepare(
        `SELECT id, title, when_ts, channel, status, fired_at, created_at
         FROM mm_reminders WHERE status = 'scheduled' AND when_ts <= ? ORDER BY when_ts ASC`,
      )
      .all(Math.floor(now)) as unknown as ReminderRow[];
    return rows.map(rowToReminder);
  }

  cancel(id: string): Reminder {
    const r = this.get(id);
    if (r.status !== 'scheduled') {
      throw new ValidationError(`cannot cancel reminder in status "${r.status}"`);
    }
    this.mdb.db.prepare(`UPDATE mm_reminders SET status = 'cancelled' WHERE id = ?`).run(id);
    return this.get(id);
  }

  done(id: string): Reminder {
    const r = this.get(id);
    if (r.status === 'cancelled') {
      throw new ValidationError('cannot mark a cancelled reminder done');
    }
    if (r.status === 'done') return r;
    this.mdb.db.prepare(`UPDATE mm_reminders SET status = 'done' WHERE id = ?`).run(id);
    return this.get(id);
  }

  /**
   * Idempotent firing entrypoint. Transitions scheduled → fired and returns
   * the reminder for delivery; returns null when already fired/done/cancelled
   * so duplicate dispatches are safe no-ops.
   */
  markFired(id: string): Reminder | null {
    const r = this.get(id);
    if (r.status !== 'scheduled') return null;
    const now = Date.now();
    const changed = this.mdb.db
      .prepare(`UPDATE mm_reminders SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'scheduled'`)
      .run(now, id);
    if (changed.changes === 0) return null; // lost a race — treat as no-op
    return this.get(id);
  }
}

/** Derive a 5-field cron expression that fires at the given ms-epoch time. */
export function cronForTimestamp(ts: number): string {
  const d = new Date(ts);
  const expr = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
  return expr;
}

/**
 * Create a reminder and register its firing trigger in the existing
 * TriggerStore. The trigger's workflowId is `muse-reminder:<reminderId>`;
 * see the module header for how the host dispatches it.
 */
export function scheduleReminder(
  store: ReminderStore,
  triggerStore: TriggerStore,
  input: { title: string; when: number; channel: ReminderChannel },
): { reminder: Reminder; trigger: Trigger } {
  const reminder = store.create(input);
  const trigger = triggerStore.create({
    workflowId: `${REMINDER_WORKFLOW_PREFIX}${reminder.id}`,
    kind: 'cron',
    cron: cronForTimestamp(reminder.when),
    enabled: true,
  });
  return { reminder, trigger };
}

/**
 * Firing entrypoint for the host scheduler wiring: call when a
 * `muse-reminder:<id>` trigger fires. Idempotent (see markFired).
 */
export function fireReminder(store: ReminderStore, reminderId: string): Reminder | null {
  return store.markFired(reminderId);
}

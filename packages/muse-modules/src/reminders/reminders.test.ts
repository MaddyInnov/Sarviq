// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerStore } from '@mvp/workflows';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import {
  ReminderStore,
  scheduleReminder,
  fireReminder,
  cronForTimestamp,
  REMINDER_WORKFLOW_PREFIX,
} from './index.js';

describe('ReminderStore', () => {
  let db: ModuleDb;
  let store: ReminderStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new ReminderStore(db);
  });

  it('creates and lists reminders', () => {
    const r = store.create({ title: 'Drink water', when: Date.now() + 60_000, channel: 'push' });
    expect(r.status).toBe('scheduled');
    expect(store.list()).toHaveLength(1);
    expect(store.list('scheduled')).toHaveLength(1);
    expect(store.list('done')).toHaveLength(0);
  });

  it('validates input', () => {
    expect(() => store.create({ title: '', when: Date.now(), channel: 'push' })).toThrow(ValidationError);
    expect(() => store.create({ title: 'x', when: -1, channel: 'push' })).toThrow(ValidationError);
    expect(() =>
      store.create({ title: 'x', when: Date.now(), channel: 'fax' as never }),
    ).toThrow(ValidationError);
  });

  it('listDue returns only due scheduled reminders', () => {
    const now = Date.now();
    const due = store.create({ title: 'due', when: now - 1000, channel: 'push' });
    store.create({ title: 'future', when: now + 3_600_000, channel: 'push' });
    const cancelled = store.create({ title: 'cancelled-due', when: now - 1000, channel: 'push' });
    store.cancel(cancelled.id);
    const list = store.listDue(now);
    expect(list.map((r) => r.id)).toEqual([due.id]);
  });

  it('cancel / done transition rules', () => {
    const r = store.create({ title: 'x', when: Date.now() + 1000, channel: 'email' });
    expect(store.cancel(r.id).status).toBe('cancelled');
    expect(() => store.cancel(r.id)).toThrow(ValidationError);
    expect(() => store.done(r.id)).toThrow(ValidationError);

    const r2 = store.create({ title: 'y', when: Date.now() + 1000, channel: 'email' });
    expect(store.done(r2.id).status).toBe('done');
    expect(store.done(r2.id).status).toBe('done'); // idempotent
  });

  it('markFired is idempotent', () => {
    const r = store.create({ title: 'x', when: Date.now() - 1000, channel: 'sms' });
    const fired = store.markFired(r.id);
    expect(fired?.status).toBe('fired');
    expect(fired?.firedAt).toBeTypeOf('number');
    expect(store.markFired(r.id)).toBeNull(); // second fire is a no-op
  });

  it('get of unknown reminder throws NotFoundError', () => {
    expect(() => store.get('nope')).toThrow(NotFoundError);
  });
});

describe('reminder scheduling via workflows triggers', () => {
  it('scheduleReminder registers a muse-reminder: cron trigger', () => {
    const db = new ModuleDb(':memory:');
    const store = new ReminderStore(db);
    const triggers = new TriggerStore(':memory:');
    // Next minute boundary so the derived cron is sane.
    const when = Date.now() + 120_000;
    const { reminder, trigger } = scheduleReminder(store, triggers, {
      title: 'standup',
      when,
      channel: 'push',
    });
    expect(trigger.workflowId).toBe(`${REMINDER_WORKFLOW_PREFIX}${reminder.id}`);
    expect(trigger.kind).toBe('cron');
    expect(trigger.cron).toBe(cronForTimestamp(when));
    triggers.close();
  });

  it('fireReminder marks the reminder fired exactly once', () => {
    const db = new ModuleDb(':memory:');
    const store = new ReminderStore(db);
    const r = store.create({ title: 'x', when: Date.now() - 5000, channel: 'push' });
    expect(fireReminder(store, r.id)?.status).toBe('fired');
    expect(fireReminder(store, r.id)).toBeNull();
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { CommitmentStore } from './index.js';

describe('CommitmentStore', () => {
  let db: ModuleDb;
  let store: CommitmentStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new CommitmentStore(db);
  });

  it('creates open commitments with optional due date and links', () => {
    const c = store.create({
      title: 'Ship v1.2',
      detail: 'cut release',
      dueAt: Date.now() + 3600_000,
      goalId: 'g1',
    });
    expect(c.status).toBe('open');
    expect(c.goalId).toBe('g1');
    expect(c.resolvedAt).toBeNull();
    expect(store.get(c.id).title).toBe('Ship v1.2');
  });

  it('validates title and dueAt', () => {
    expect(() => store.create({ title: '  ' })).toThrow(ValidationError);
    expect(() => store.create({ title: 'x', dueAt: -5 })).toThrow(ValidationError);
    expect(() => store.get('nope')).toThrow(NotFoundError);
  });

  it('resolves kept/missed with an outcome, then rejects further transitions', () => {
    const c = store.create({ title: 'Call accountant' });
    const kept = store.resolve(c.id, 'kept', 'called, books closed');
    expect(kept.status).toBe('kept');
    expect(kept.outcome).toBe('called, books closed');
    expect(kept.resolvedAt).not.toBeNull();
    expect(() => store.resolve(c.id, 'missed')).toThrow(ValidationError);
    expect(() => store.cancel(c.id)).toThrow(ValidationError);
  });

  it('cancels open commitments', () => {
    const c = store.create({ title: 'Optional thing' });
    expect(store.cancel(c.id).status).toBe('cancelled');
  });

  it('lists overdue open commitments only', () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 3600_000;
    const overdue = store.create({ title: 'overdue', dueAt: past });
    store.create({ title: 'future', dueAt: future });
    store.create({ title: 'no due date' });
    const missed = store.create({ title: 'was overdue', dueAt: past });
    store.resolve(missed.id, 'missed', 'forgot');
    const list = store.listOverdue();
    expect(list.map((c) => c.id)).toEqual([overdue.id]);
  });

  it('links a reminder to an open commitment', () => {
    const c = store.create({ title: 'Pay invoice' });
    const linked = store.linkReminder(c.id, 'rem-123');
    expect(linked.reminderId).toBe('rem-123');
  });

  it('lists by status', () => {
    const a = store.create({ title: 'a' });
    const b = store.create({ title: 'b' });
    store.resolve(b.id, 'kept');
    expect(store.list('open').map((c) => c.id)).toEqual([a.id]);
    expect(store.list('kept').map((c) => c.id)).toEqual([b.id]);
    expect(() => store.list('bogus' as never)).toThrow(ValidationError);
  });
});

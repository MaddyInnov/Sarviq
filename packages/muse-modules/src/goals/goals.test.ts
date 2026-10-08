// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { GoalStore } from './index.js';

describe('GoalStore', () => {
  let db: ModuleDb;
  let store: GoalStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new GoalStore(db);
  });

  it('creates goals at 0% with seeded history', () => {
    const g = store.create({ title: 'Run a marathon', description: 'By December' });
    expect(g.status).toBe('active');
    expect(g.progress).toBe(0);
    expect(store.history(g.id)).toHaveLength(1);
  });

  it('validates title', () => {
    expect(() => store.create({ title: '  ' })).toThrow(ValidationError);
    expect(() => store.get('nope')).toThrow(NotFoundError);
  });

  it('updateProgress records history and forbids regression', () => {
    const g = store.create({ title: 'Read 12 books' });
    const updated = store.updateProgress(g.id, 25, 'finished book 3');
    expect(updated.progress).toBe(25);
    expect(updated.status).toBe('active');
    expect(() => store.updateProgress(g.id, 10)).toThrow(ValidationError);
    expect(() => store.updateProgress(g.id, 101)).toThrow(ValidationError);
    const history = store.history(g.id);
    expect(history.map((h) => h.pct)).toEqual([0, 25]);
    expect(history[1].note).toBe('finished book 3');
  });

  it('reaching 100% auto-completes', () => {
    const g = store.create({ title: 'Ship MVP' });
    const done = store.updateProgress(g.id, 100);
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(100);
    expect(() => store.updateProgress(g.id, 100)).toThrow(ValidationError);
  });

  it('complete() marks done explicitly', () => {
    const g = store.create({ title: 'Inbox zero' });
    store.updateProgress(g.id, 40);
    expect(store.complete(g.id).status).toBe('completed');
    expect(store.list('completed')).toHaveLength(1);
    expect(store.list('active')).toHaveLength(0);
  });
});

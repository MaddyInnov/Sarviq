// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { WatcherStore, evaluateWatcher, WATCHER_WORKFLOW_PREFIX } from './index.js';

describe('WatcherStore', () => {
  let db: ModuleDb;
  let store: WatcherStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new WatcherStore(db);
  });

  it('creates enabled watchers and validates input', () => {
    const w = store.create({ name: 'price drop', description: 'watch BTC', cron: '0 9 * * *' });
    expect(w.enabled).toBe(true);
    expect(w.cron).toBe('0 9 * * *');
    expect(w.lastCondition).toBeNull();
    expect(() => store.create({ name: '  ' })).toThrow(ValidationError);
    expect(() => store.create({ name: 'x', cron: 'not a cron' })).toThrow(ValidationError);
    expect(() => store.get('nope')).toThrow(NotFoundError);
  });

  it('fires only on false→true transitions (edge-triggered)', () => {
    const w = store.create({ name: 'w' });
    // First true fires (never evaluated counts as not-true).
    let r = evaluateWatcher(store, db, w.id, { condition: true, detail: 'became true' });
    expect(r.fired).toBe(true);
    expect(r.event).not.toBeNull();
    expect(r.event!.detail).toBe('became true');
    expect(store.events(w.id)).toHaveLength(1);

    // Still true → no new event.
    r = evaluateWatcher(store, db, w.id, { condition: true });
    expect(r.fired).toBe(false);
    expect(store.events(w.id)).toHaveLength(1);

    // Back to false → no event, but state recorded.
    r = evaluateWatcher(store, db, w.id, { condition: false });
    expect(r.fired).toBe(false);
    expect(r.watcher.lastCondition).toBe(false);

    // False → true again → fires.
    r = evaluateWatcher(store, db, w.id, { condition: true, detail: 'again' });
    expect(r.fired).toBe(true);
    expect(store.events(w.id)).toHaveLength(2);
    expect(store.get(w.id).lastFiredAt).not.toBeNull();
  });

  it('records lastCheckedAt on every evaluation', () => {
    const w = store.create({ name: 'w' });
    evaluateWatcher(store, db, w.id, { condition: false });
    expect(store.get(w.id).lastCheckedAt).not.toBeNull();
  });

  it('refuses to evaluate disabled watchers', () => {
    const w = store.create({ name: 'w' });
    store.setEnabled(w.id, false);
    expect(() => evaluateWatcher(store, db, w.id, { condition: true })).toThrow(ValidationError);
    store.setEnabled(w.id, true);
    const r = evaluateWatcher(store, db, w.id, { condition: true });
    expect(r.fired).toBe(true);
  });

  it('deletes watchers and their events', () => {
    const w = store.create({ name: 'w' });
    evaluateWatcher(store, db, w.id, { condition: true });
    store.delete(w.id);
    expect(() => store.get(w.id)).toThrow(NotFoundError);
    expect(store.list()).toHaveLength(0);
  });

  it('exposes the workflow prefix constant', () => {
    expect(WATCHER_WORKFLOW_PREFIX).toBe('muse-watcher:');
  });
});

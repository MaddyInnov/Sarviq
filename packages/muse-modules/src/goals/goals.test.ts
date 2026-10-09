// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { GoalStore, GoalMilestoneStore } from './index.js';

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

describe('GoalMilestoneStore', () => {
  let db: ModuleDb;
  let store: GoalStore;
  let milestones: GoalMilestoneStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new GoalStore(db);
    milestones = new GoalMilestoneStore(db);
  });

  it('adds milestones in order and lists them', () => {
    const g = store.create({ title: 'Launch' });
    const m1 = milestones.add(g.id, { title: 'Design' });
    const m2 = milestones.add(g.id, { title: 'Build' });
    expect(m1.position).toBe(0);
    expect(m2.position).toBe(1);
    expect(milestones.list(g.id).map((m) => m.title)).toEqual(['Design', 'Build']);
    const detail = milestones.detail(g.id);
    expect(detail.milestonesTotal).toBe(2);
    expect(detail.milestonesDone).toBe(0);
  });

  it('validates milestone input', () => {
    const g = store.create({ title: 'Launch' });
    expect(() => milestones.add(g.id, { title: '  ' })).toThrow(ValidationError);
    expect(() => milestones.add('nope', { title: 'x' })).toThrow(NotFoundError);
    expect(() => milestones.complete(g.id, 'nope')).toThrow(NotFoundError);
  });

  it('completing all milestones auto-completes the goal', () => {
    const g = store.create({ title: 'Launch' });
    const m1 = milestones.add(g.id, { title: 'Design' });
    const m2 = milestones.add(g.id, { title: 'Build' });
    let r = milestones.complete(g.id, m1.id);
    expect(r.milestone.done).toBe(true);
    expect(r.goal.status).toBe('active');
    r = milestones.complete(g.id, m2.id);
    expect(r.goal.status).toBe('completed');
    expect(r.goal.progress).toBe(100);
    const history = store.history(g.id);
    expect(history[history.length - 1].note).toBe('all milestones complete');
  });

  it('rejects milestones on completed goals and cross-goal completion', () => {
    const g = store.create({ title: 'Done goal' });
    store.complete(g.id);
    expect(() => milestones.add(g.id, { title: 'late' })).toThrow(ValidationError);
    const h = store.create({ title: 'Other' });
    const m = milestones.add(h.id, { title: 'x' });
    expect(() => milestones.complete(g.id, m.id)).toThrow(ValidationError);
  });
});

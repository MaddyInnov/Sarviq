// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TeamDirectoryStore,
  enrichActor,
  withEnrichedRunActors,
  type TeamRun,
} from '../src/teams.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-teamdir-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(store: TeamDirectoryStore) {
  const priya = store.addMember({
    name: 'Priya Sharma',
    handle: 'priya',
    email: 'priya@example.com',
    role: 'Engineering Manager',
    team: 'Platform',
    timezone: 'Asia/Kolkata',
    relationship: 'manager',
  });
  const alex = store.addMember({
    name: 'Alex Chen',
    handle: '@alexchen',
    email: 'ALEX@EXAMPLE.COM',
    role: 'Designer',
    team: 'Platform',
    relationship: 'teammate',
  });
  return { priya, alex };
}

describe('TeamDirectoryStore', () => {
  it('adds, lists, gets, updates, and deletes members', () => {
    const store = new TeamDirectoryStore(dir);
    const { priya } = seed(store);
    expect(store.listMembers()).toHaveLength(2);
    expect(store.getMember(priya.id)?.email).toBe('priya@example.com');

    const updated = store.updateMember(priya.id, { role: 'Senior EM', notes: 'on leave in Dec' });
    expect(updated?.role).toBe('Senior EM');
    expect(updated?.notes).toBe('on leave in Dec');

    expect(store.deleteMember(priya.id)).toBe(true);
    expect(store.getMember(priya.id)).toBeUndefined();
    expect(store.deleteMember(priya.id)).toBe(false);
  });

  it('requires a name and validates field types', () => {
    const store = new TeamDirectoryStore(dir);
    expect(() => store.addMember({ name: '' })).toThrow();
    expect(() => store.addMember({ name: '   ' })).toThrow();
    expect(store.updateMember('missing', { role: 'x' })).toBeUndefined();
  });

  it('persists members across instances', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    const reopened = new TeamDirectoryStore(dir);
    expect(reopened.listMembers()).toHaveLength(2);
    expect(reopened.findByHandle('priya')?.role).toBe('Engineering Manager');
  });

  it('finds by handle/email/name with case-insensitive normalization', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    expect(store.findByHandle('@priya')?.name).toBe('Priya Sharma');
    expect(store.findByHandle('ALEXCHEN')?.name).toBe('Alex Chen');
    expect(store.findByEmail('alex@example.com')?.name).toBe('Alex Chen');
    expect(store.findByEmail('PRIYA@EXAMPLE.COM')?.name).toBe('Priya Sharma');
    expect(store.findByName('priya sharma')?.handle).toBe('priya');
    expect(store.findByName('Nobody')).toBeUndefined();
  });
});

describe('enrichActor', () => {
  it('matches bare strings by handle exact (case-insensitive, @ optional)', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    const enriched = enrichActor('PRIYA', store);
    expect(enriched).toMatchObject({
      actor: 'PRIYA',
      role: 'Engineering Manager',
      team: 'Platform',
      relationship: 'manager',
    });
    expect(enrichActor('@alexchen', store)).toMatchObject({ role: 'Designer', team: 'Platform' });
  });

  it('matches email strings exactly, case-insensitively', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    expect(enrichActor('Priya@Example.com', store)).toMatchObject({ role: 'Engineering Manager' });
  });

  it('matches names case-insensitively', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    expect(enrichActor('alex chen', store)).toMatchObject({
      role: 'Designer',
      relationship: 'teammate',
    });
  });

  it('matches actor objects by handle/email/name', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    expect(enrichActor({ handle: 'priya' }, store)).toMatchObject({ role: 'Engineering Manager' });
    expect(enrichActor({ email: 'alex@example.com' }, store)).toMatchObject({ role: 'Designer' });
    expect(enrichActor({ name: 'Priya Sharma' }, store)).toMatchObject({ team: 'Platform' });
  });

  it('prefers handle over email over name for actor objects', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    // handle 'priya' wins over name 'Alex Chen'
    expect(enrichActor({ handle: 'priya', name: 'Alex Chen' }, store)).toMatchObject({
      role: 'Engineering Manager',
    });
  });

  it('passes unmatched actors through unchanged', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    expect(enrichActor('stranger-danger', store)).toBe('stranger-danger');
    const obj = { name: 'Stranger', handle: 'nobody' };
    expect(enrichActor(obj, store)).toBe(obj);
    expect(enrichActor('', store)).toBe('');
  });

  it('works against a plain entry array too', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    const entries = store.listMembers();
    expect(enrichActor('priya', entries)).toMatchObject({ role: 'Engineering Manager' });
  });
});

describe('withEnrichedRunActors', () => {
  it('enriches step actors where matched, passes others through', () => {
    const store = new TeamDirectoryStore(dir);
    seed(store);
    const run: TeamRun = {
      id: 'run-1',
      teamId: 'team-1',
      task: 'ship it',
      status: 'done',
      steps: [
        { memberBotId: 'b1', memberName: 'priya', task: 'review', done: true },
        { memberBotId: 'b2', memberName: 'unknown-bot', task: 'build', done: true },
      ],
      createdAt: Date.now(),
    };
    const enriched = withEnrichedRunActors(run, store);
    expect(enriched.steps[0].actor).toMatchObject({
      actor: 'priya',
      role: 'Engineering Manager',
      team: 'Platform',
      relationship: 'manager',
    });
    expect(enriched.steps[1].actor).toBe('unknown-bot');
    // original run untouched
    expect((run.steps[0] as { actor?: unknown }).actor).toBeUndefined();
  });
});

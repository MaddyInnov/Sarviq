// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { ThreadStore } from './index.js';

describe('ThreadStore', () => {
  let db: ModuleDb;
  let store: ThreadStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new ThreadStore(db);
  });

  it('creates threads with a default title', () => {
    const t = store.create();
    expect(t.title).toBe('Untitled thread');
    expect(store.list()).toHaveLength(1);
  });

  it('adds messages in order and bumps updatedAt', () => {
    const t = store.create({ title: 'Side quest' });
    store.addMessage(t.id, 'user', 'hello');
    store.addMessage(t.id, 'assistant', 'hi there');
    const { thread, messages } = store.get(t.id);
    expect(thread.title).toBe('Side quest');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages.map((m) => m.content)).toEqual(['hello', 'hi there']);
  });

  it('validates role and content', () => {
    const t = store.create();
    expect(() => store.addMessage(t.id, 'bot' as never, 'x')).toThrow(ValidationError);
    expect(() => store.addMessage(t.id, 'user', '   ')).toThrow(ValidationError);
  });

  it('renames and removes threads', () => {
    const t = store.create();
    expect(store.rename(t.id, 'Renamed').title).toBe('Renamed');
    expect(() => store.rename(t.id, '')).toThrow(ValidationError);
    store.addMessage(t.id, 'user', 'bye');
    store.remove(t.id);
    expect(store.list()).toHaveLength(0);
    expect(() => store.get(t.id)).toThrow(NotFoundError);
  });

  it('unknown thread throws NotFoundError', () => {
    expect(() => store.get('nope')).toThrow(NotFoundError);
    expect(() => store.messages('nope')).toThrow(NotFoundError);
  });
});

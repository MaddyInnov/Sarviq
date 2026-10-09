// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SPACE_ID,
  SpaceError,
  SpaceStore,
} from '../src/spaces.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-spaces-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SpaceStore', () => {
  it('always has an unpausable Default space', () => {
    const store = new SpaceStore(dir);
    const spaces = store.listSpaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0].id).toBe(DEFAULT_SPACE_ID);
    expect(spaces[0].name).toBe('Default');
    expect(spaces[0].paused).toBe(false);
  });

  it('creates, gets, lists, and deletes spaces', () => {
    const store = new SpaceStore(dir);
    const space = store.createSpace('Work');
    expect(space.id).not.toBe(DEFAULT_SPACE_ID);
    expect(space.name).toBe('Work');
    expect(space.paused).toBe(false);

    expect(store.getSpace(space.id)?.name).toBe('Work');
    expect(store.listSpaces()).toHaveLength(2);
    expect(store.listSpaces()[0].id).toBe(DEFAULT_SPACE_ID); // Default first

    expect(store.deleteSpace(space.id)).toBe(true);
    expect(store.getSpace(space.id)).toBeUndefined();
    expect(store.deleteSpace(space.id)).toBe(false);
  });

  it('rejects empty or overlong names', () => {
    const store = new SpaceStore(dir);
    expect(() => store.createSpace('')).toThrow(SpaceError);
    expect(() => store.createSpace('   ')).toThrow(SpaceError);
    expect(() => store.createSpace('x'.repeat(81))).toThrow(SpaceError);
  });

  it('patches name, modelOverride, apiKeyRef, workspaceOverride, paused', () => {
    const store = new SpaceStore(dir);
    const space = store.createSpace('Work');
    const updated = store.updateSpace(space.id, {
      modelOverride: 'groq/llama-3.3-70b-versatile',
      apiKeyRef: 'GROQ_WORK_KEY',
      workspaceOverride: 'work',
      paused: true,
    });
    expect(updated.modelOverride).toBe('groq/llama-3.3-70b-versatile');
    expect(updated.apiKeyRef).toBe('GROQ_WORK_KEY');
    expect(updated.workspaceOverride).toBe('work');
    expect(updated.paused).toBe(true);
    expect(updated.name).toBe('Work');
  });

  it('clears optional overrides with null or empty string', () => {
    const store = new SpaceStore(dir);
    const space = store.createSpace('Work');
    store.updateSpace(space.id, { modelOverride: 'x', apiKeyRef: 'K', workspaceOverride: 'w' });
    const cleared = store.updateSpace(space.id, { modelOverride: null, apiKeyRef: '', workspaceOverride: null });
    expect(cleared.modelOverride).toBeUndefined();
    expect(cleared.apiKeyRef).toBeUndefined();
    expect(cleared.workspaceOverride).toBeUndefined();
  });

  it('never pauses or deletes the Default space', () => {
    const store = new SpaceStore(dir);
    expect(() => store.updateSpace(DEFAULT_SPACE_ID, { paused: true })).toThrow(SpaceError);
    expect(() => store.deleteSpace(DEFAULT_SPACE_ID)).toThrow(SpaceError);
    expect(store.getSpace(DEFAULT_SPACE_ID)?.paused).toBe(false);
  });

  it('rejects invalid apiKeyRef and workspaceOverride values', () => {
    const store = new SpaceStore(dir);
    const space = store.createSpace('Work');
    expect(() => store.updateSpace(space.id, { apiKeyRef: 'not a name!!' })).toThrow(SpaceError);
    expect(() => store.updateSpace(space.id, { workspaceOverride: '../escape' })).toThrow(SpaceError);
    expect(() => store.updateSpace(space.id, { workspaceOverride: '/etc/passwd' })).toThrow(SpaceError);
    expect(() => store.updateSpace(space.id, { paused: 'yes' as unknown as boolean })).toThrow(SpaceError);
  });

  it('accepts absolute workspaceOverride inside the data dir', () => {
    const store = new SpaceStore(dir);
    const space = store.createSpace('Work');
    const inside = join(dir, 'workspaces', 'mine');
    const updated = store.updateSpace(space.id, { workspaceOverride: inside });
    expect(updated.workspaceOverride).toBe(inside);
  });

  it('throws not-found for unknown spaces', () => {
    const store = new SpaceStore(dir);
    expect(() => store.updateSpace('nope', { name: 'x' })).toThrowError(SpaceError);
    try {
      store.updateSpace('nope', { name: 'x' });
      expect.unreachable();
    } catch (err) {
      expect((err as SpaceError).code).toBe('not-found');
    }
  });

  it('persists across store instances', () => {
    const store = new SpaceStore(dir);
    const space = store.createSpace('Personal');
    store.updateSpace(space.id, { modelOverride: 'model-x', paused: true });
    const reopened = new SpaceStore(dir);
    expect(reopened.listSpaces()).toHaveLength(2);
    const again = reopened.getSpace(space.id);
    expect(again?.modelOverride).toBe('model-x');
    expect(again?.paused).toBe(true);
  });

  it('stores only the apiKeyRef reference — never a raw key value', () => {
    const store = new SpaceStore(dir);
    const space = store.createSpace('Work');
    store.updateSpace(space.id, { apiKeyRef: 'MY_KEY_REF' });
    const raw = readFileSync(join(dir, 'spaces.json'), 'utf8');
    expect(raw).toContain('MY_KEY_REF');
    expect(raw).not.toContain('sk-');
    const listed = store.listSpaces().find((s) => s.id === space.id);
    expect(listed?.apiKeyRef).toBe('MY_KEY_REF');
  });

  it('resolves by id or exact name', () => {
    const store = new SpaceStore(dir);
    const space = store.createSpace('Work');
    expect(store.resolveSpace(space.id)?.name).toBe('Work');
    expect(store.resolveSpace('Work')?.id).toBe(space.id);
    expect(store.resolveSpace('Default')?.id).toBe(DEFAULT_SPACE_ID);
    expect(store.resolveSpace('Missing')).toBeUndefined();
  });
});

// SPDX-License-Identifier: Apache-2.0
// Tests for the subagent bookkeeping layer:
// - SubagentStore: record/finish lifecycle, parent/child links, depth walks
// - spawnSubagent: stub spawn + audit recorder; spawned/finished events,
//   failure marking, and the nesting depth limit (fail closed).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentStore } from '../src/subagent-store.js';
import { MAX_SUBAGENT_DEPTH, spawnSubagent } from '../src/subagents.js';
import type { SubagentSpawnFn } from '../src/subagents.js';
import type { AuditEntry } from '../src/governance.js';

let dir: string;
let store: SubagentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-subagents-'));
  store = new SubagentStore(join(dir, 'subagents.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function auditRecorder() {
  const events: Array<Omit<AuditEntry, 'ts'>> = [];
  const audit = (entry: Omit<AuditEntry, 'ts'>): void => {
    events.push(entry);
  };
  return { events, audit };
}

describe('SubagentStore', () => {
  it('records a running child and finishes it with usage', () => {
    const rec = store.spawnChild({
      sessionId: 'sess-child-1',
      parentSessionId: 'sess-root',
      parentBotId: 'bot-a',
      task: 'research X',
    });
    expect(rec.status).toBe('running');
    expect(rec.parentSessionId).toBe('sess-root');
    expect(rec.parentBotId).toBe('bot-a');
    expect(rec.finishedAt).toBeNull();

    store.finish(rec.id, 'done', { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    const done = store.get(rec.id)!;
    expect(done.status).toBe('done');
    expect(done.finishedAt).not.toBeNull();
    expect(JSON.parse(done.usageJson!)).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('marks failed children', () => {
    const rec = store.spawnChild({
      sessionId: 'sess-child-2',
      parentSessionId: 'sess-root',
      parentBotId: 'bot-a',
      task: 'doomed task',
    });
    store.finish(rec.id, 'failed');
    expect(store.get(rec.id)!.status).toBe('failed');
  });

  it('refuses to finish a non-running record (terminal transitions only)', () => {
    const rec = store.spawnChild({
      sessionId: 'sess-child-3',
      parentSessionId: 'sess-root',
      parentBotId: 'bot-a',
      task: 'once',
    });
    store.finish(rec.id, 'done');
    expect(() => store.finish(rec.id, 'done')).toThrow(/no running subagent/);
    expect(() => store.finish('sub_nope', 'done')).toThrow(/no running subagent/);
  });

  it('lists children by parent session', () => {
    store.spawnChild({ sessionId: 'c1', parentSessionId: 'p1', parentBotId: 'b', task: 't1' });
    store.spawnChild({ sessionId: 'c2', parentSessionId: 'p1', parentBotId: 'b', task: 't2' });
    store.spawnChild({ sessionId: 'c3', parentSessionId: 'p2', parentBotId: 'b', task: 't3' });
    const kids = store.listByParent('p1');
    expect(kids.map((k) => k.task)).toEqual(['t1', 't2']);
  });

  it('computes nesting depth by walking the session chain', () => {
    expect(store.getDepth('sess-root')).toBe(0);
    store.spawnChild({ sessionId: 'child', parentSessionId: 'sess-root', parentBotId: 'b', task: 't' });
    expect(store.getDepth('child')).toBe(1);
    store.spawnChild({ sessionId: 'grand', parentSessionId: 'child', parentBotId: 'b', task: 't' });
    expect(store.getDepth('grand')).toBe(2);
    expect(store.getDepth('sess-root')).toBe(0);
  });
});

describe('spawnSubagent', () => {
  it('records parent/child, emits audit events, returns the stub result', async () => {
    const { events, audit } = auditRecorder();
    const spawn: SubagentSpawnFn = vi.fn(async (input) => {
      expect(input.task).toBe('summarize the docs');
      expect(input.parentSessionId).toBe('sess-root');
      expect(input.botId).toBe('bot-a');
      return { result: 'summary text', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } };
    });

    const out = await spawnSubagent({
      store,
      spawn,
      audit,
      parentBotId: 'bot-a',
      parentSessionId: 'sess-root',
      task: 'summarize the docs',
    });

    expect(out.result).toBe('summary text');
    expect(out.subagentId).toMatch(/^sub_/);
    const rec = store.get(out.subagentId)!;
    expect(rec.status).toBe('done');
    expect(rec.parentSessionId).toBe('sess-root');
    expect(rec.parentBotId).toBe('bot-a');

    expect(events.map((e) => e.type)).toEqual(['subagent.spawned', 'subagent.finished']);
    expect(events[0]).toMatchObject({ sessionId: 'sess-root', botId: 'bot-a' });
    expect(events[0]!.detail).toMatchObject({ subagentId: out.subagentId });
    expect(events[1]!.detail).toMatchObject({ status: 'done' });
  });

  it('marks the record failed and still audits when spawn rejects', async () => {
    const { events, audit } = auditRecorder();
    const spawn: SubagentSpawnFn = async () => {
      throw new Error('child exploded');
    };

    await expect(
      spawnSubagent({
        store,
        spawn,
        audit,
        parentBotId: 'bot-a',
        parentSessionId: 'sess-root',
        task: 'boom',
      }),
    ).rejects.toThrow('child exploded');

    const kids = store.listByParent('sess-root');
    expect(kids).toHaveLength(1);
    expect(kids[0]!.status).toBe('failed');
    expect(events.map((e) => e.type)).toEqual(['subagent.spawned', 'subagent.finished']);
    expect(events[1]!.detail).toMatchObject({ status: 'failed' });
  });

  it('enforces the depth limit and never calls spawn past it', async () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(2);
    // Build root -> child -> grandchild (grandchild sits at depth 2).
    store.spawnChild({ sessionId: 'child', parentSessionId: 'sess-root', parentBotId: 'b', task: 't' });
    store.spawnChild({ sessionId: 'grand', parentSessionId: 'child', parentBotId: 'b', task: 't' });
    expect(store.getDepth('grand')).toBe(2);

    const spawn = vi.fn<SubagentSpawnFn>(async () => ({ result: 'never' }));
    const { audit } = auditRecorder();
    await expect(
      spawnSubagent({
        store,
        spawn,
        audit,
        parentBotId: 'b',
        parentSessionId: 'grand',
        task: 'one too deep',
      }),
    ).rejects.toThrow(/nesting limit/);
    expect(spawn).not.toHaveBeenCalled();
    expect(store.listByParent('grand')).toHaveLength(0);
  });

  it('works without an audit sink (no throw)', async () => {
    const out = await spawnSubagent({
      store,
      spawn: async () => ({ result: 'ok' }),
      parentBotId: 'b',
      parentSessionId: 'sess-root',
      task: 'no audit',
    });
    expect(out.result).toBe('ok');
    expect(store.get(out.subagentId)!.status).toBe('done');
  });
});

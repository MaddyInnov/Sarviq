// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DefaultActionRunner,
  ProcessingRuleStore,
} from '../src/processing-rules.js';
import type { ActionRunner, ProcessingItem } from '../src/processing-rules.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'proc-rules-test-')), 'processing-rules.db');
}

const stores: ProcessingRuleStore[] = [];
function freshStore(): ProcessingRuleStore {
  const s = new ProcessingRuleStore(tmpDb());
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

const item = (over: Partial<ProcessingItem> = {}): ProcessingItem => ({
  id: 'item-1',
  kind: 'message',
  source: 'chat',
  text: 'please escalate this outage to oncall',
  ...over,
});

describe('ProcessingRuleStore CRUD', () => {
  it('creates, reads, lists, updates, deletes rules', () => {
    const store = freshStore();
    const rule = store.createRule({
      name: 'escalate outages',
      match: { textPattern: 'outage', kind: 'message' },
      actions: [
        { type: 'tag', params: { tag: 'urgent' } },
        { type: 'route', params: { destination: 'oncall-queue' } },
      ],
    });
    expect(rule.id).toMatch(/^rule_/);
    expect(rule.enabled).toBe(true);
    expect(rule.actions.length).toBe(2);

    expect(store.getRule(rule.id)?.name).toBe('escalate outages');
    expect(store.listRules().length).toBe(1);

    const updated = store.updateRule(rule.id, { name: 'escalate outages v2', enabled: false });
    expect(updated.name).toBe('escalate outages v2');
    expect(updated.enabled).toBe(false);
    expect(store.listRules({ enabledOnly: true }).length).toBe(0);

    expect(store.deleteRule(rule.id)).toBe(true);
    expect(store.getRule(rule.id)).toBeUndefined();
    expect(store.deleteRule(rule.id)).toBe(false);
  });

  it('rejects invalid rules fail-fast', () => {
    const store = freshStore();
    expect(() => store.createRule({ name: '', actions: [{ type: 'tag', params: { tag: 'x' } }] })).toThrow();
    expect(() => store.createRule({ name: 'x', actions: [] })).toThrow(/non-empty array/);
    expect(() =>
      store.createRule({ name: 'x', actions: [{ type: 'nuke', params: {} }] }),
    ).toThrow(/tag\|route\|run-agent\|egress/);
    expect(() =>
      store.createRule({ name: 'x', actions: [{ type: 'tag', params: {} }] }),
    ).toThrow(/requires a non-empty string param "tag"/);
    expect(() =>
      store.createRule({ name: 'x', match: { textPattern: '(unclosed' }, actions: [{ type: 'tag', params: { tag: 't' } }] }),
    ).toThrow(/valid regular expression/);
    expect(() => store.updateRule('nope', { name: 'y' })).toThrow(/unknown processing rule/);
  });
});

describe('rule firing + firing log', () => {
  it('fires matching rules in order and logs every action', async () => {
    const store = freshStore();
    const r1 = store.createRule({
      name: 'tag urgent',
      match: { textPattern: 'outage' },
      actions: [{ type: 'tag', params: { tag: 'urgent' } }],
    });
    const r2 = store.createRule({
      name: 'route oncall',
      match: { kind: 'message', source: 'chat' },
      actions: [
        { type: 'route', params: { destination: 'oncall' } },
        { type: 'run-agent', params: { agentId: 'triage-bot' } }, // no agent runner → skipped
      ],
    });
    // Disabled rule must not fire.
    store.createRule({
      name: 'disabled',
      enabled: false,
      match: {},
      actions: [{ type: 'tag', params: { tag: 'never' } }],
    });

    const report = await store.fire(item());
    expect(report.matchedRuleIds).toEqual([r1.id, r2.id]);
    expect(report.firings.length).toBe(3);
    expect(report.firings.map((f) => f.action)).toEqual(['tag', 'route', 'run-agent']);
    expect(report.firings.map((f) => f.status)).toEqual(['success', 'success', 'skipped']);
    expect(report.firings[2].reason).toMatch(/no agent runner/);
    // Every firing carries rule id, item, action, timestamp.
    for (const f of report.firings) {
      expect(f.ts).toBeGreaterThan(0);
      expect(f.itemId).toBe('item-1');
      expect(f.itemKind).toBe('message');
      expect([r1.id, r2.id]).toContain(f.ruleId);
    }
  });

  it('matcher requires ALL specified fields (AND)', async () => {
    const store = freshStore();
    store.createRule({
      name: 'strict',
      match: { kind: 'file', textPattern: 'outage' },
      actions: [{ type: 'tag', params: { tag: 'x' } }],
    });
    const report = await store.fire(item()); // kind=message, text matches
    expect(report.matchedRuleIds).toEqual([]);
    expect(report.firings).toEqual([]);
    expect(store.queryFiringLog().length).toBe(0);
  });

  it('runner exceptions become error entries, firing never throws', async () => {
    const store = freshStore();
    store.createRule({
      name: 'boom',
      match: {},
      actions: [{ type: 'tag', params: { tag: 'x' } }],
    });
    const badRunner: ActionRunner = {
      run: async () => {
        throw new Error('runner exploded');
      },
    };
    const report = await store.fire(item(), { runner: badRunner });
    expect(report.firings.length).toBe(1);
    expect(report.firings[0].status).toBe('error');
    expect(report.firings[0].reason).toBe('runner exploded');
  });

  it('custom runners really execute run-agent and egress actions', async () => {
    const store = freshStore();
    store.createRule({
      name: 'full',
      match: {},
      actions: [
        { type: 'run-agent', params: { agentId: 'triage-bot' } },
        { type: 'egress', params: { target: 'https://hooks.example.com/x' } },
      ],
    });
    const seen: string[] = [];
    const runner = new DefaultActionRunner({
      agentRunner: async (action) => {
        seen.push(`agent:${action.params['agentId']}`);
        return { status: 'success', detail: { runId: 'run-1' } };
      },
      egressRunner: async (action) => {
        seen.push(`egress:${action.params['target']}`);
        return { status: 'success' };
      },
    });
    const report = await store.fire(item(), { runner });
    expect(seen).toEqual(['agent:triage-bot', 'egress:https://hooks.example.com/x']);
    expect(report.firings.map((f) => f.status)).toEqual(['success', 'success']);
    expect(report.firings[0].detail).toEqual({ runId: 'run-1' });
  });
});

describe('queryFiringLog', () => {
  it('filters by rule, status, and time range', async () => {
    const store = freshStore();
    const ok = store.createRule({
      name: 'ok',
      match: { kind: 'message' },
      actions: [{ type: 'tag', params: { tag: 'a' } }],
    });
    const skip = store.createRule({
      name: 'skip',
      match: { kind: 'message' },
      actions: [{ type: 'egress', params: { target: 't' } }], // skipped, no egress runner
    });
    await store.fire(item({ id: 'i-1' }));
    await store.fire(item({ id: 'i-2', kind: 'file' })); // matches neither

    expect(store.queryFiringLog().length).toBe(2);
    expect(store.queryFiringLog({ ruleId: ok.id }).length).toBe(1);
    expect(store.queryFiringLog({ ruleId: skip.id })[0].status).toBe('skipped');
    expect(store.queryFiringLog({ status: 'success' }).length).toBe(1);
    expect(store.queryFiringLog({ status: 'skipped' })[0].ruleId).toBe(skip.id);

    const now = Date.now();
    expect(store.queryFiringLog({ since: now + 60_000 }).length).toBe(0);
    expect(store.queryFiringLog({ until: now - 60_000 }).length).toBe(0);
    expect(store.queryFiringLog({ since: now - 60_000, until: now + 60_000 }).length).toBe(2);
    expect(store.queryFiringLog({ limit: 1 }).length).toBe(1);
  });
});

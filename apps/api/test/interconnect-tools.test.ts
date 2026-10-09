// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/interconnect-tools.ts (feature interconnection):
// workflow_start starts a run via the runner, notes_save/read/search round
// trip through NoteStore, and the governance policy rules classify the new
// tools (reads allow, writes require-approval). Temp data dirs only.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@mvp/agent-runtime';
import type { WorkflowRunner } from '@mvp/workflows';
import { interconnectionPolicyRules, registerInterconnectionTools } from '../src/interconnect-tools.js';
import { NoteStore } from '../src/notes.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-interconnect-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeRunner(): { runner: WorkflowRunner; started: Array<{ workflowId: string; input: unknown }> } {
  const started: Array<{ workflowId: string; input: unknown }> = [];
  const runner = {
    getWorkflow: (id: string) => {
      if (id !== 'wf-1') throw new Error(`unknown workflow: ${id}`);
      return { id: 'wf-1', name: 'W', nodes: [], edges: [] };
    },
    startRun: async (workflowId: string, input: unknown, _opts?: { idempotencyKey?: string }) => {
      started.push({ workflowId, input });
      return { id: 'run-1', workflowId, status: 'running' as const };
    },
  } as unknown as WorkflowRunner;
  return { runner, started };
}

function registered(): Map<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  const { runner } = fakeRunner();
  registerInterconnectionTools({ registry, workflowRunner: runner, dataDir: dir });
  return registry;
}

describe('interconnect tools', () => {
  it('registers all four tools without clobbering existing ones', () => {
    const registry = new Map<string, ToolDefinition>();
    const existing: ToolDefinition = {
      name: 'workflow_start',
      description: 'mine',
      parameters: {},
      handler: async () => ({}),
    };
    registry.set('workflow_start', existing);
    const { runner } = fakeRunner();
    registerInterconnectionTools({ registry, workflowRunner: runner, dataDir: dir });
    expect(registry.get('workflow_start')).toBe(existing);
    expect(registry.has('notes_save')).toBe(true);
    expect(registry.has('notes_read')).toBe(true);
    expect(registry.has('notes_search')).toBe(true);
  });

  it('workflow_start starts a run and returns the run id', async () => {
    const { runner, started } = fakeRunner();
    const registry = new Map<string, ToolDefinition>();
    registerInterconnectionTools({ registry, workflowRunner: runner, dataDir: dir });
    const out = (await registry.get('workflow_start')!.handler(
      { workflowId: 'wf-1', input: { a: 1 } },
      { sessionId: 's', botId: 'b' },
    )) as { runId: string; workflowId: string; status: string };
    expect(out.runId).toBe('run-1');
    expect(out.workflowId).toBe('wf-1');
    expect(out.status).toBe('running');
    expect(started).toEqual([{ workflowId: 'wf-1', input: { a: 1 } }]);
  });

  it('workflow_start rejects unknown workflows with a clear error', async () => {
    const reg2 = new Map<string, ToolDefinition>();
    registerInterconnectionTools({ registry: reg2, workflowRunner: fakeRunner().runner, dataDir: dir });
    await expect(
      reg2.get('workflow_start')!.handler({ workflowId: 'nope' }, { sessionId: 's', botId: 'b' }),
    ).rejects.toThrow(/unknown workflow/);
  });

  it('notes_save creates then updates a note', async () => {
    const registry = registered();
    const save = registry.get('notes_save')!;
    const read = registry.get('notes_read')!;
    const ctx = { sessionId: 's', botId: 'b' };
    const created = (await save.handler({ title: 'T', content: 'hello' }, ctx)) as { id: string };
    expect(created.id).toBeTruthy();
    const note = (await read.handler({ id: created.id }, ctx)) as { title: string; content: string };
    expect(note.title).toBe('T');
    expect(note.content).toBe('hello');
    await save.handler({ id: created.id, title: 'T2', content: 'bye' }, ctx);
    const updated = (await read.handler({ id: created.id }, ctx)) as { title: string; content: string };
    expect(updated.title).toBe('T2');
    expect(updated.content).toBe('bye');
    // persisted in the data dir's notes.json
    expect(new NoteStore(dir).get(created.id)?.title).toBe('T2');
  });

  it('notes_read throws on unknown id; notes_search finds by keyword', async () => {
    const registry = registered();
    const ctx = { sessionId: 's', botId: 'b' };
    await expect(registry.get('notes_read')!.handler({ id: 'missing' }, ctx)).rejects.toThrow(/unknown note/);
    await registry.get('notes_save')!.handler({ title: 'Grocery list', content: 'buy oat milk' }, ctx);
    await registry.get('notes_save')!.handler({ title: 'Ideas', content: 'write a novel' }, ctx);
    const hits = (await registry.get('notes_search')!.handler({ query: 'oat milk' }, ctx)) as Array<{
      id: string;
      title: string;
      snippet: string;
    }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe('Grocery list');
    expect(hits[0]!.snippet).toContain('oat milk');
    await expect(registry.get('notes_search')!.handler({ query: '' }, ctx)).rejects.toThrow(/non-empty/);
  });

  it('policy rules: reads allow, writes require approval', () => {
    const rules = interconnectionPolicyRules();
    const find = (name: string) => {
      const rule = rules.find((r) => new RegExp(r.toolPattern).test(name));
      expect(rule, `no rule matched ${name}`).toBeDefined();
      return rule!;
    };
    expect(find('notes_read').effect).toBe('allow');
    expect(find('notes_search').effect).toBe('allow');
    expect(find('workflow_start').effect).toBe('require-approval');
    expect(find('notes_save').effect).toBe('require-approval');
    // every rule has an id and a reason (auditable)
    for (const r of rules) {
      expect(r.id).toBeTruthy();
      expect(r.reason).toBeTruthy();
    }
  });
});

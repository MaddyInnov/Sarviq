// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import type { EvalContext, EvaluateResult, GovernanceGateway } from '@mvp/governance';
import { WorkflowRunner, evaluateCode } from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

// ---------------------------------------------------------------------------
// Minimal fakes (same surface the runner needs; no paid APIs, no network).
// ---------------------------------------------------------------------------

class FakeGovernance {
  async evaluate(
    _toolName: string,
    _args: Record<string, unknown>,
    _ctx: EvalContext,
  ): Promise<EvaluateResult> {
    return { effect: 'allow' };
  }
  requestApproval(): string {
    throw new Error('not used in these tests');
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return 'approved';
  }
  asGateway(): GovernanceGateway {
    return this as unknown as GovernanceGateway;
  }
}

function makeRunner(): WorkflowRunner {
  const runtime = {
    runTurn: async () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  } as unknown as AgentRuntime;
  return new WorkflowRunner({
    dbPath: ':memory:',
    agentRuntime: runtime,
    governance: new FakeGovernance().asGateway(),
    tools: new Map(),
    bots: new Map<string, BotConfig>(),
  });
}

function branchDef(condition: string): WorkflowDefinition {
  return {
    id: 'wf-branch',
    name: 'Branch',
    nodes: [
      { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
      { id: 'check', type: 'if', name: 'Check', config: { condition } },
      { id: 'on-true', type: 'set', name: 'On true', config: { assignments: { path: 'taken-true' } } },
      { id: 'on-false', type: 'set', name: 'On false', config: { assignments: { path: 'taken-false' } } },
      { id: 'join', type: 'set', name: 'Join', config: { assignments: { done: true } } },
    ],
    edges: [
      ['trigger', 'check'],
      ['check', 'on-true', 'true'],
      ['check', 'on-false', 'false'],
      ['on-true', 'join'],
      ['on-false', 'join'],
    ],
  };
}

describe('if node', () => {
  it('takes the true branch and skips the false branch', async () => {
    const runner = makeRunner();
    runner.register(branchDef('{{input.n}} > 5'));
    const created = await runner.startRun('wf-branch', { n: 10 });
    const run = await runner.awaitRun(created.id);

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['check']?.output).toEqual({ condition: true });
    expect(run.nodeStates['on-true']?.status).toBe('succeeded');
    expect(run.nodeStates['on-true']?.output).toEqual({ path: 'taken-true' });
    expect(run.nodeStates['on-false']?.status).toBe('skipped');
    // Join has one active incoming edge (on-true) → still runs.
    expect(run.nodeStates['join']?.status).toBe('succeeded');
    runner.close();
  });

  it('takes the false branch and skips the true branch', async () => {
    const runner = makeRunner();
    runner.register(branchDef('{{input.n}} > 5'));
    const created = await runner.startRun('wf-branch', { n: 1 });
    const run = await runner.awaitRun(created.id);

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['check']?.output).toEqual({ condition: false });
    expect(run.nodeStates['on-true']?.status).toBe('skipped');
    expect(run.nodeStates['on-false']?.status).toBe('succeeded');
    expect(run.nodeStates['join']?.status).toBe('succeeded');
    runner.close();
  });

  it('skips whole subtrees below an untaken branch', async () => {
    const runner = makeRunner();
    const def: WorkflowDefinition = {
      id: 'wf-subtree',
      name: 'Subtree',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
        { id: 'check', type: 'if', name: 'Check', config: { condition: '{{input.go}}' } },
        { id: 't1', type: 'set', name: 'T1', config: { assignments: { a: 1 } } },
        { id: 't2', type: 'set', name: 'T2', config: { assignments: { b: 2 } } },
      ],
      edges: [
        ['trigger', 'check'],
        ['check', 't1', 'true'],
        ['t1', 't2'],
      ],
    };
    runner.register(def);
    const created = await runner.startRun('wf-subtree', { go: false });
    const run = await runner.awaitRun(created.id);

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['t1']?.status).toBe('skipped');
    expect(run.nodeStates['t2']?.status).toBe('skipped');
    runner.close();
  });

  it('accepts a plain boolean template result as the condition', async () => {
    const runner = makeRunner();
    runner.register(branchDef('{{input.flag}}'));
    const created = await runner.startRun('wf-branch', { flag: true });
    const run = await runner.awaitRun(created.id);
    expect(run.nodeStates['check']?.output).toEqual({ condition: true });
    expect(run.nodeStates['on-false']?.status).toBe('skipped');
    runner.close();
  });

  it('fails the run when the condition expression is invalid', async () => {
    const runner = makeRunner();
    runner.register(branchDef('this is not (valid js'));
    const created = await runner.startRun('wf-branch', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['check']?.status).toBe('failed');
    expect(run.nodeStates['check']?.error).toMatch(/condition expression failed/);
    runner.close();
  });
});

describe('set node', () => {
  it('builds an object from template assignments', async () => {
    const runner = makeRunner();
    const def: WorkflowDefinition = {
      id: 'wf-set',
      name: 'Set',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
        {
          id: 'shape',
          type: 'set',
          name: 'Shape',
          config: {
            assignments: {
              email: '{{input.user.email}}',
              count: '{{input.items.length}}',
              literal: 'static',
              nested: '{{input.user}}',
            },
          },
        },
      ],
      edges: [['trigger', 'shape']],
    };
    runner.register(def);
    const created = await runner.startRun('wf-set', {
      user: { email: 'a@b.c' },
      items: [1, 2, 3],
    });
    const run = await runner.awaitRun(created.id);

    expect(run.status).toBe('succeeded');
    // Single-placeholder templates preserve value types (number, object).
    expect(run.nodeStates['shape']?.output).toEqual({
      email: 'a@b.c',
      count: 3,
      literal: 'static',
      nested: { email: 'a@b.c' },
    });
    runner.close();
  });

  it('merges run input underneath assignments when includeInput is true', async () => {
    const runner = makeRunner();
    const def: WorkflowDefinition = {
      id: 'wf-set-merge',
      name: 'Set merge',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
        {
          id: 'shape',
          type: 'set',
          name: 'Shape',
          config: { assignments: { b: 'overridden' }, includeInput: true },
        },
      ],
      edges: [['trigger', 'shape']],
    };
    runner.register(def);
    const created = await runner.startRun('wf-set-merge', { a: 1, b: 'original' });
    const run = await runner.awaitRun(created.id);
    expect(run.nodeStates['shape']?.output).toEqual({ a: 1, b: 'overridden' });
    runner.close();
  });
});

describe('code node', () => {
  it('runs JS with input/nodes in scope and returns the completion value', async () => {
    const runner = makeRunner();
    const def: WorkflowDefinition = {
      id: 'wf-code',
      name: 'Code',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
        {
          id: 'prep',
          type: 'set',
          name: 'Prep',
          config: { assignments: { factor: '{{input.factor}}' } },
        },
        {
          id: 'calc',
          type: 'code',
          name: 'Calc',
          config: {
            code: 'const f = nodes.prep.output.factor;\nreturn { doubled: input.n * f, items: input.list.map(x => x * 2) };',
          },
        },
      ],
      edges: [
        ['trigger', 'prep'],
        ['prep', 'calc'],
      ],
    };
    runner.register(def);
    const created = await runner.startRun('wf-code', { n: 21, factor: 2, list: [1, 2] });
    const run = await runner.awaitRun(created.id);

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['calc']?.output).toEqual({ doubled: 42, items: [2, 4] });
    runner.close();
  });

  it('supports async code via await', async () => {
    const runner = makeRunner();
    const def: WorkflowDefinition = {
      id: 'wf-code-async',
      name: 'Code async',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
        {
          id: 'calc',
          type: 'code',
          name: 'Calc',
          config: { code: 'const v = await Promise.resolve(input.n + 1);\nreturn { v };' },
        },
      ],
      edges: [['trigger', 'calc']],
    };
    runner.register(def);
    const created = await runner.startRun('wf-code-async', { n: 1 });
    const run = await runner.awaitRun(created.id);
    expect(run.nodeStates['calc']?.output).toEqual({ v: 2 });
    runner.close();
  });

  it('fails the node when the code throws', async () => {
    const runner = makeRunner();
    const def: WorkflowDefinition = {
      id: 'wf-code-throw',
      name: 'Code throw',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
        { id: 'calc', type: 'code', name: 'Calc', config: { code: "throw new Error('boom');" } },
      ],
      edges: [['trigger', 'calc']],
    };
    runner.register(def);
    const created = await runner.startRun('wf-code-throw', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['calc']?.error).toMatch(/boom/);
    runner.close();
  });

  it('kills synchronous infinite loops via the timeout', async () => {
    const runner = makeRunner();
    const def: WorkflowDefinition = {
      id: 'wf-code-loop',
      name: 'Code loop',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
        {
          id: 'calc',
          type: 'code',
          name: 'Calc',
          config: { code: 'while (true) {}', timeoutMs: 300 },
        },
      ],
      edges: [['trigger', 'calc']],
    };
    runner.register(def);
    const created = await runner.startRun('wf-code-loop', {});
    const run = await runner.awaitRun(created.id, 10_000);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['calc']?.error).toMatch(/timed out/i);
    runner.close();
  });
});

describe('code sandbox isolation', () => {
  it('exposes no host globals to workflow code', async () => {
    const out = await evaluateCode(
      'return { noProcess: typeof process, noRequire: typeof require, noFetch: typeof fetch, answer: input.constructor.constructor("return 42")() };',
      { input: { a: 1 }, nodes: {} },
    );
    // The in-realm Function constructor works (proves the realm is intact)
    // but host objects are unreachable from it.
    expect(out).toEqual({ noProcess: 'undefined', noRequire: 'undefined', noFetch: 'undefined', answer: 42 });
  });

  it('rejects non-JSON-serializable input', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(evaluateCode('return 1;', { input: circular, nodes: {} })).rejects.toThrow(
      /not JSON-serializable/,
    );
  });
});

describe('new node validation', () => {
  it('rejects an if node without a condition', () => {
    const runner = makeRunner();
    expect(() =>
      runner.register({
        id: 'bad-if',
        name: 'Bad',
        nodes: [
          { id: 'trigger', type: 'trigger', name: 'T', config: {} },
          { id: 'c', type: 'if', name: 'C', config: {} },
        ],
        edges: [['trigger', 'c']],
      }),
    ).toThrow(/config\.condition/);
    runner.close();
  });

  it('rejects a code node without code', () => {
    const runner = makeRunner();
    expect(() =>
      runner.register({
        id: 'bad-code',
        name: 'Bad',
        nodes: [
          { id: 'trigger', type: 'trigger', name: 'T', config: {} },
          { id: 'c', type: 'code', name: 'C', config: { code: '   ' } },
        ],
        edges: [['trigger', 'c']],
      }),
    ).toThrow(/config\.code/);
    runner.close();
  });

  it('rejects a set node with non-object assignments', () => {
    const runner = makeRunner();
    expect(() =>
      runner.register({
        id: 'bad-set',
        name: 'Bad',
        nodes: [
          { id: 'trigger', type: 'trigger', name: 'T', config: {} },
          { id: 's', type: 'set', name: 'S', config: { assignments: 'nope' } },
        ],
        edges: [['trigger', 's']],
      }),
    ).toThrow(/config\.assignments/);
    runner.close();
  });

  it('rejects branch labels on edges leaving non-if nodes', () => {
    const runner = makeRunner();
    expect(() =>
      runner.register({
        id: 'bad-edge',
        name: 'Bad',
        nodes: [
          { id: 'trigger', type: 'trigger', name: 'T', config: {} },
          { id: 's', type: 'set', name: 'S', config: { assignments: {} } },
        ],
        edges: [['trigger', 's', 'true']],
      }),
    ).toThrow(/branch label/);
    runner.close();
  });

  it('rejects invalid branch labels', () => {
    const runner = makeRunner();
    expect(() =>
      runner.register({
        id: 'bad-label',
        name: 'Bad',
        nodes: [
          { id: 'trigger', type: 'trigger', name: 'T', config: {} },
          { id: 'c', type: 'if', name: 'C', config: { condition: 'true' } },
          { id: 's', type: 'set', name: 'S', config: { assignments: {} } },
        ],
        edges: [
          ['trigger', 'c'],
          ['c', 's', 'maybe' as 'true'],
        ],
      }),
    ).toThrow(/invalid branch label/);
    runner.close();
  });
});

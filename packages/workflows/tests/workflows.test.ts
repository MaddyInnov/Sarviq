// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, beforeEach } from 'vitest';
import type { AgentRuntime, BotConfig, StreamEvent, TokenUsage, ToolDefinition } from '@mvp/agent-runtime';
import type { EvalContext, EvaluateResult, GovernanceGateway } from '@mvp/governance';
import { WorkflowRunner } from '../src/index.js';
import { renderTemplate } from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fakes matching the type surface used by WorkflowRunner.
// ---------------------------------------------------------------------------

interface RunTurnCall {
  botId: string;
  sessionId: string;
  message: string;
}

const TEST_BOT: BotConfig = {
  id: 'bot-1',
  name: 'Test Bot',
  description: 'test bot',
  systemPrompt: 'test',
  provider: 'groq',
  model: 'gpt-oss-20b',
  skills: [],
  tools: [],
  mcpServers: [],
};

const TEST_USAGE: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function makeFakeRuntime(onTurn?: (call: RunTurnCall) => string): {
  runtime: AgentRuntime;
  calls: RunTurnCall[];
} {
  const calls: RunTurnCall[] = [];
  const runtime = {
    runTurn: async (options: {
      bot: BotConfig;
      message: string;
      sessionId?: string;
      onEvent?: (e: StreamEvent) => void | Promise<void>;
    }): Promise<TokenUsage> => {
      const call: RunTurnCall = {
        botId: options.bot.id,
        sessionId: options.sessionId ?? '',
        message: options.message,
      };
      calls.push(call);
      const text = onTurn ? onTurn(call) : 'canned agent reply';
      // Exercise the onEvent token path like a real runtime would.
      await options.onEvent?.({ type: 'token', content: text } as StreamEvent);
      await options.onEvent?.({ type: 'done', usage: TEST_USAGE } as StreamEvent);
      return TEST_USAGE;
    },
  } as AgentRuntime;
  return { runtime, calls };
}

/** Manual-decision fake: tests call decide() to resolve pending approvals. */
class FakeGovernance {
  policy: 'allow' | 'require-approval' | 'deny' = 'allow';
  created: { approvalId: string; toolName: string; args: Record<string, unknown> }[] = [];
  private resolvers = new Map<string, (d: 'approved' | 'denied') => void>();
  private seq = 0;

  async evaluate(
    toolName: string,
    args: Record<string, unknown>,
    _ctx: EvalContext,
  ): Promise<EvaluateResult> {
    if (this.policy === 'require-approval') {
      const approvalId = this.requestApproval(toolName, args, _ctx);
      return { effect: 'require-approval', approvalId };
    }
    return { effect: this.policy };
  }

  requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    _ctx: EvalContext,
  ): string {
    const approvalId = `approval-${++this.seq}`;
    this.created.push({ approvalId, toolName, args });
    return approvalId;
  }

  awaitDecision(approvalId: string): Promise<'approved' | 'denied'> {
    return new Promise<'approved' | 'denied'>((resolve) => {
      this.resolvers.set(approvalId, resolve);
    });
  }

  decide(approvalId: string, approved: boolean): void {
    const resolve = this.resolvers.get(approvalId);
    if (!resolve) throw new Error(`no pending approval ${approvalId}`);
    this.resolvers.delete(approvalId);
    resolve(approved ? 'approved' : 'denied');
  }

  asGateway(): GovernanceGateway {
    return this as unknown as GovernanceGateway;
  }
}

function makeRunner(opts?: {
  governance?: FakeGovernance;
  runtimeText?: (call: RunTurnCall) => string;
  tools?: Map<string, ToolDefinition>;
}): { runner: WorkflowRunner; governance: FakeGovernance; toolCalls: string[] } {
  const governance = opts?.governance ?? new FakeGovernance();
  const { runtime } = makeFakeRuntime(opts?.runtimeText);
  const toolCalls: string[] = [];
  const tools =
    opts?.tools ??
    new Map<string, ToolDefinition>([
      [
        'echo-tool',
        {
          name: 'echo-tool',
          description: 'test tool',
          parameters: {},
          handler: async (args) => {
            toolCalls.push('echo-tool');
            return { echoed: args };
          },
        },
      ],
    ]);
  const bots = new Map<string, BotConfig>([['bot-1', TEST_BOT]]);
  const runner = new WorkflowRunner({
    dbPath: ':memory:',
    agentRuntime: runtime,
    governance: governance.asGateway(),
    tools,
    bots,
  });
  return { runner, governance, toolCalls };
}

function triggerNode(id = 'trigger'): WorkflowDefinition['nodes'][number] {
  return { id, type: 'trigger', name: 'Trigger', config: {} };
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 5000,
  message = 'condition not met in time',
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('linear DAG execution', () => {
  it('executes trigger -> agent -> tool in order with interpolated outputs', async () => {
    const order: string[] = [];
    const { runtime } = makeFakeRuntime((call) => {
      order.push('agent');
      expect(call.message).toBe('Summarize this: hello world');
      return 'the summary';
    });
    const governance = new FakeGovernance();
    const tools = new Map<string, ToolDefinition>([
      [
        'store',
        {
          name: 'store',
          description: 'test tool',
          parameters: {},
          handler: async (args) => {
            order.push('tool');
            expect(args).toEqual({ text: 'the summary', tag: 't1' });
            return { stored: true };
          },
        },
      ],
    ]);
    const bots = new Map<string, BotConfig>([['bot-1', TEST_BOT]]);
    const runner = new WorkflowRunner({
      dbPath: ':memory:',
      agentRuntime: runtime,
      governance: governance.asGateway(),
      tools,
      bots,
    });

    const def: WorkflowDefinition = {
      id: 'wf-linear',
      name: 'Linear',
      nodes: [
        triggerNode(),
        {
          id: 'agent1',
          type: 'agent',
          name: 'Agent',
          config: { botId: 'bot-1', prompt: 'Summarize this: {{input.text}}' },
        },
        {
          id: 'tool1',
          type: 'tool',
          name: 'Tool',
          config: { tool: 'store', args: { text: '{{nodes.agent1.output}}', tag: 't1' } },
        },
      ],
      edges: [
        ['trigger', 'agent1'],
        ['agent1', 'tool1'],
      ],
    };
    runner.register(def);

    const created = await runner.startRun('wf-linear', { text: 'hello world' });
    const run = await runner.awaitRun(created.id);

    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['trigger']?.output).toEqual({ text: 'hello world' });
    expect(run.nodeStates['agent1']?.output).toBe('the summary');
    expect(run.nodeStates['tool1']?.output).toEqual({ stored: true });
    expect(order).toEqual(['agent', 'tool']);
    runner.close();
  });
});

describe('idempotency', () => {
  it('same idempotency key returns the existing run and executes once', async () => {
    let handlerCalls = 0;
    const tools = new Map<string, ToolDefinition>([
      ['count', { name: 'count', description: 'test tool', parameters: {}, handler: async () => ({ n: ++handlerCalls }) }],
    ]);
    const { runner } = makeRunner({ tools });
    runner.register({
      id: 'wf-idem',
      name: 'Idempotent',
      nodes: [
        triggerNode(),
        { id: 't1', type: 'tool', name: 'T', config: { tool: 'count', args: {} } },
      ],
      edges: [['trigger', 't1']],
    });

    const first = await runner.startRun('wf-idem', {}, { idempotencyKey: 'key-123' });
    const second = await runner.startRun('wf-idem', {}, { idempotencyKey: 'key-123' });
    expect(second.id).toBe(first.id);

    const run = await runner.awaitRun(first.id);
    expect(run.status).toBe('succeeded');
    expect(handlerCalls).toBe(1);
    runner.close();
  });
});

describe('approval node', () => {
  const approvalWorkflow = (): WorkflowDefinition => ({
    id: 'wf-approval',
    name: 'Approval',
    nodes: [
      triggerNode(),
      { id: 'appr', type: 'approval', name: 'Approve', config: { message: 'Ship it?' } },
      { id: 't1', type: 'tool', name: 'T', config: { tool: 'echo-tool', args: { ok: true } } },
    ],
    edges: [
      ['trigger', 'appr'],
      ['appr', 't1'],
    ],
  });

  it('pauses then resumes on approve', async () => {
    const { runner, governance, toolCalls } = makeRunner();
    runner.register(approvalWorkflow());

    const created = await runner.startRun('wf-approval', {});
    await waitFor(() => runner.getRun(created.id)?.status === 'paused', 5000, 'run did not pause');

    const paused = runner.getRun(created.id)!;
    expect(paused.nodeStates['appr']?.status).toBe('paused');
    const approvalId = paused.nodeStates['appr']?.approvalId;
    expect(approvalId).toBeDefined();
    expect(governance.created[0]?.toolName).toBe('workflow-approval');
    expect(toolCalls).toEqual([]);

    governance.decide(approvalId!, true);
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['appr']?.output).toEqual({ approved: true });
    expect(toolCalls).toEqual(['echo-tool']);
    runner.close();
  });

  it('denied approval fails the run', async () => {
    const { runner, governance, toolCalls } = makeRunner();
    runner.register(approvalWorkflow());

    const created = await runner.startRun('wf-approval', {});
    await waitFor(() => runner.getRun(created.id)?.status === 'paused', 5000, 'run did not pause');
    const approvalId = runner.getRun(created.id)!.nodeStates['appr']?.approvalId;

    governance.decide(approvalId!, false);
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['appr']?.status).toBe('failed');
    expect(run.nodeStates['appr']?.error).toMatch(/denied/i);
    expect(toolCalls).toEqual([]);
    runner.close();
  });

  it('tool node pauses for governance require-approval then runs on approve', async () => {
    const governance = new FakeGovernance();
    governance.policy = 'require-approval';
    const { runner, toolCalls } = makeRunner({ governance });
    runner.register({
      id: 'wf-tool-approval',
      name: 'ToolApproval',
      nodes: [
        triggerNode(),
        { id: 't1', type: 'tool', name: 'T', config: { tool: 'echo-tool', args: { x: 1 } } },
      ],
      edges: [['trigger', 't1']],
    });

    const created = await runner.startRun('wf-tool-approval', {});
    await waitFor(() => runner.getRun(created.id)?.status === 'paused', 5000, 'run did not pause');
    const approvalId = runner.getRun(created.id)!.nodeStates['t1']?.approvalId;
    expect(governance.created[0]?.toolName).toBe('echo-tool');

    governance.decide(approvalId!, true);
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['t1']?.output).toEqual({ echoed: { x: 1 } });
    expect(toolCalls).toEqual(['echo-tool']);
    runner.close();
  });
});

describe('http node', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, echo: body ? JSON.parse(body) : null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  it('posts templated body and parses JSON response', async () => {
    const { runner } = makeRunner();
    runner.register({
      id: 'wf-http',
      name: 'HTTP',
      nodes: [
        triggerNode(),
        {
          id: 'h1',
          type: 'http',
          name: 'POST',
          config: {
            method: 'POST',
            url: `http://127.0.0.1:${port}/echo`,
            body: { q: '{{input.q}}', nested: { v: 2 } },
          },
        },
      ],
      edges: [['trigger', 'h1']],
    });

    const created = await runner.startRun('wf-http', { q: 'hello' });
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    const output = run.nodeStates['h1']?.output as { status: number; body: unknown };
    expect(output.status).toBe(200);
    expect(output.body).toEqual({ method: 'POST', echo: { q: 'hello', nested: { v: 2 } } });
    runner.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('validation', () => {
  it('throws on cycles', () => {
    const { runner } = makeRunner();
    expect(() =>
      runner.register({
        id: 'wf-cycle',
        name: 'Cycle',
        nodes: [triggerNode('a'), { id: 'b', type: 'delay', name: 'B', config: { seconds: 0 } }],
        edges: [
          ['a', 'b'],
          ['b', 'a'],
        ],
      }),
    ).toThrow(/cycle/i);
    runner.close();
  });

  it('throws on duplicate node ids, bad edges, and missing/multiple triggers', () => {
    const { runner } = makeRunner();
    expect(() =>
      runner.register({
        id: 'wf-dup',
        name: 'Dup',
        nodes: [triggerNode('a'), { id: 'a', type: 'delay', name: 'B', config: {} }],
        edges: [],
      }),
    ).toThrow(/duplicate node id/);
    expect(() =>
      runner.register({
        id: 'wf-edge',
        name: 'Edge',
        nodes: [triggerNode('a')],
        edges: [['a', 'ghost']],
      }),
    ).toThrow(/unknown node/);
    expect(() =>
      runner.register({
        id: 'wf-notrig',
        name: 'NoTrigger',
        nodes: [{ id: 'a', type: 'delay', name: 'A', config: {} }],
        edges: [],
      }),
    ).toThrow(/exactly one trigger/);
    runner.close();
  });

  it('marks unreachable nodes skipped without hanging', async () => {
    const { runner } = makeRunner();
    runner.register({
      id: 'wf-unreach',
      name: 'Unreachable',
      nodes: [
        triggerNode(),
        { id: 't1', type: 'delay', name: 'T', config: { seconds: 0 } },
        { id: 'orphan', type: 'delay', name: 'O', config: { seconds: 0 } },
      ],
      edges: [['trigger', 't1']],
    });
    const created = await runner.startRun('wf-unreach', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    expect(run.nodeStates['orphan']?.status).toBe('skipped');
    runner.close();
  });
});

describe('fan-out and join', () => {
  it('runs parallel branches and joins before the sink', async () => {
    const seen: string[] = [];
    const tools = new Map<string, ToolDefinition>([
      [
        'rec',
        {
          name: 'rec',
          description: 'test tool',
          parameters: {},
          handler: async (args) => {
            await new Promise((r) => setTimeout(r, 20));
            seen.push(args['branch'] as string);
            return { branch: args['branch'] };
          },
        },
      ],
    ]);
    const { runner } = makeRunner({ tools });
    runner.register({
      id: 'wf-fan',
      name: 'Fan',
      nodes: [
        triggerNode(),
        { id: 'b1', type: 'tool', name: 'B1', config: { tool: 'rec', args: { branch: 'b1' } } },
        { id: 'b2', type: 'tool', name: 'B2', config: { tool: 'rec', args: { branch: 'b2' } } },
        {
          id: 'sink',
          type: 'tool',
          name: 'Sink',
          config: {
            tool: 'rec',
            args: { branch: 'sink-{{nodes.b1.output.branch}}-{{nodes.b2.output.branch}}' },
          },
        },
      ],
      edges: [
        ['trigger', 'b1'],
        ['trigger', 'b2'],
        ['b1', 'sink'],
        ['b2', 'sink'],
      ],
    });
    const created = await runner.startRun('wf-fan', {});
    const run = await runner.awaitRun(created.id);
    expect(run.status).toBe('succeeded');
    // sink ran after both branches (join semantics)
    expect(seen[2]).toBe('sink-b1-b2');
    expect(seen.slice(0, 2).sort()).toEqual(['b1', 'b2']);
    runner.close();
  });
});

describe('onRunUpdate', () => {
  it('fires on node transitions and run status changes', async () => {
    const { runner } = makeRunner();
    runner.register({
      id: 'wf-events',
      name: 'Events',
      nodes: [
        triggerNode(),
        { id: 't1', type: 'delay', name: 'T', config: { seconds: 0 } },
      ],
      edges: [['trigger', 't1']],
    });
    const statuses: string[] = [];
    const unsubscribe = runner.onRunUpdate((run) => {
      statuses.push(`${run.status}:${run.nodeStates['t1']?.status}`);
    });
    const created = await runner.startRun('wf-events', {});
    await runner.awaitRun(created.id);
    unsubscribe();
    const extraCalls: string[] = [];
    runner.onRunUpdate((run) => extraCalls.push(run.id));
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]).toBe('succeeded:succeeded');
    expect(extraCalls).toEqual([]);
    runner.close();
  });
});

describe('renderTemplate', () => {
  it('interpolates input, node outputs and dot-paths recursively', () => {
    const ctx = { input: { name: 'Ash', deep: { n: 42 } }, nodes: { a: { text: 'hi', list: [1, 2] } } };
    expect(renderTemplate('Hello {{input.name}}!', ctx)).toBe('Hello Ash!');
    expect(renderTemplate('{{input.deep.n}}', ctx)).toBe(42);
    expect(renderTemplate('{{input}}', ctx)).toEqual({ name: 'Ash', deep: { n: 42 } });
    expect(renderTemplate('{{nodes.a.output.text}}', ctx)).toBe('hi');
    expect(renderTemplate('{{nodes.a.output}}', ctx)).toEqual({ text: 'hi', list: [1, 2] });
    expect(
      renderTemplate({ arr: ['{{nodes.a.output.list}}', 'x-{{input.missing}}'], keep: 1 }, ctx),
    ).toEqual({ arr: [[1, 2], 'x-'], keep: 1 });
    expect(renderTemplate(123, ctx)).toBe(123);
    expect(renderTemplate(null, ctx)).toBeNull();
  });
});

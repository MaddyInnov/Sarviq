// SPDX-License-Identifier: Apache-2.0
// Peer-delegation gate in AgentRuntime.runTurn (workstream C): the gate is
// consulted BEFORE governance on `delegate` tool calls; a deny aborts the
// subtask with a clear message and never executes the tool.

import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolCall, ToolContext, ToolDefinition } from '../src/types.js';
import type { DelegateGate } from '../src/runtime.js';

class AllowGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> {
    return 'allow';
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: 'allow' };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return 'approved';
  }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

function testBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'coord',
    name: 'Coordinator',
    description: 'coordinates',
    systemPrompt: 'You coordinate.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: ['delegate'],
    mcpServers: [],
    ...overrides,
  };
}

function makeRuntime(tools: ToolDefinition[], provider: MockProvider): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): MockProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-gate-test-skills-missing',
    governance: new AllowGateway(),
    toolRegistry: new Map(tools.map((t) => [t.name, t])),
    defaultProviderId: 'mock',
  });
}

const delegateCall: ToolCall = {
  id: 'call-1',
  name: 'delegate',
  args: { task: 'write the code', bot: 'coder' },
};

describe('delegateGate', () => {
  it('denies the delegate call before governance: tool never executes, clear message', async () => {
    const provider = new MockProvider([{ toolCalls: [delegateCall] }, { content: 'done' }]);
    const handler = vi.fn(async () => 'code written');
    const delegateTool: ToolDefinition = {
      name: 'delegate',
      description: 'd',
      parameters: {},
      handler,
    };
    const runtime = makeRuntime([delegateTool], provider);
    const events: StreamEvent[] = [];
    const gate: DelegateGate = async () => ({ decision: 'deny', reason: 'user said no' });

    await runtime.runTurn({
      bot: testBot(),
      message: 'go',
      sessionId: 'gate-deny',
      delegateGate: gate,
      onEvent: (e) => void events.push(e),
    });

    expect(handler).not.toHaveBeenCalled();
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    const tr = toolResults[0]!;
    expect(tr.type).toBe('tool_result');
    if (tr.type === 'tool_result') {
      expect(tr.denied).toBe(true);
      expect(tr.result).toEqual({ denied: true, reason: 'user said no' });
    }
    // The coordinator sees the denial as a tool message (assert via second turn's history is overkill;
    // the emitted tool_result already carries the clear message).
  });

  it('allow continues into normal governance and executes the tool', async () => {
    const provider = new MockProvider([{ toolCalls: [delegateCall] }, { content: 'done' }]);
    const handler = vi.fn(async () => 'code written');
    const delegateTool: ToolDefinition = {
      name: 'delegate',
      description: 'd',
      parameters: {},
      handler,
    };
    const runtime = makeRuntime([delegateTool], provider);
    const gate: DelegateGate = async (call: ToolCall, ctx: ToolContext) => {
      expect(call.name).toBe('delegate');
      expect(ctx.botId).toBe('coord');
      return { decision: 'allow' };
    };
    const events: StreamEvent[] = [];
    await runtime.runTurn({
      bot: testBot(),
      message: 'go',
      sessionId: 'gate-allow',
      delegateGate: gate,
      onEvent: (e) => void events.push(e),
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
  });

  it('a throwing gate fails closed (deny)', async () => {
    const provider = new MockProvider([{ toolCalls: [delegateCall] }, { content: 'done' }]);
    const handler = vi.fn(async () => 'code written');
    const delegateTool: ToolDefinition = {
      name: 'delegate',
      description: 'd',
      parameters: {},
      handler,
    };
    const runtime = makeRuntime([delegateTool], provider);
    const gate: DelegateGate = async () => {
      throw new Error('broker exploded');
    };
    const events: StreamEvent[] = [];
    await runtime.runTurn({
      bot: testBot(),
      message: 'go',
      sessionId: 'gate-throw',
      delegateGate: gate,
      onEvent: (e) => void events.push(e),
    });
    expect(handler).not.toHaveBeenCalled();
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr?.type).toBe('tool_result');
    if (tr?.type === 'tool_result') {
      expect(tr.result).toEqual({ denied: true, reason: 'delegation gate failed: broker exploded' });
    }
  });

  it('does not consult the gate for other tools', async () => {
    const otherCall: ToolCall = { id: 'c2', name: 'adder', args: {} };
    const provider = new MockProvider([{ toolCalls: [otherCall] }, { content: 'done' }]);
    const adder: ToolDefinition = {
      name: 'adder',
      description: 'a',
      parameters: {},
      handler: async () => 42,
    };
    const runtime = makeRuntime([adder], provider);
    const gate = vi.fn(async () => ({ decision: 'deny' as const, reason: 'nope' }));
    await runtime.runTurn({
      bot: testBot(),
      message: 'go',
      sessionId: 'gate-other',
      delegateGate: gate,
      onEvent: () => {},
    });
    expect(gate).not.toHaveBeenCalled();
  });
});

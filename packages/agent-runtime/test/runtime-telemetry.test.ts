// SPDX-License-Identifier: Apache-2.0
// Tests for runTurn telemetry instrumentation: per-step latency, error
// counting, and token cost recorded on the collector.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, ToolDefinition } from '../src/types.js';
import { TelemetryCollector } from '../src/telemetry.js';

class FakeGateway implements GovernanceGateway {
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
    id: 'bot-telemetry',
    name: 'Telemetry Bot',
    description: 'A bot for telemetry tests',
    systemPrompt: 'You are a test bot.',
    provider: 'mock',
    model: 'mock-model',
    skills: [],
    tools: [],
    mcpServers: [],
    ...overrides,
  };
}

function makeRuntime(telemetry: TelemetryCollector, tools: ToolDefinition[], provider: MockProvider): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): MockProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: new FakeGateway(),
    toolRegistry: new Map(tools.map((t) => [t.name, t])),
    defaultProviderId: 'mock',
    telemetry,
  });
}

const noop = (): void => {};

describe('runTurn telemetry', () => {
  it('records one run with llm + tool steps, tokens, and cost', async () => {
    const telemetry = new TelemetryCollector();
    const adder: ToolDefinition = {
      name: 'adder',
      description: 'Adds two numbers',
      parameters: { type: 'object', properties: {} },
      handler: async (args) => (args.a as number) + (args.b as number),
    };
    const provider = new MockProvider([
      {
        toolCalls: [{ id: 'c1', name: 'adder', args: { a: 2, b: 3 } }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: 'The answer is 5',
        usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
      },
    ]);
    const runtime = makeRuntime(telemetry, [adder], provider);
    try {
      await runtime.runTurn({ bot: testBot({ tools: ['adder'] }), message: 'add 2 and 3', onEvent: noop });
      const runs = telemetry.listRuns(10);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.kind).toBe('bot-turn');
      expect(run.botId).toBe('bot-telemetry');
      expect(run.status).toBe('ok');
      expect(run.totalTokens).toBe(39);
      expect(run.iterations).toBe(2);
      expect(Number.isFinite(run.costUsd)).toBe(true);
      const kinds = run.steps.map((s) => s.kind);
      // Iteration 1: llm → tool executes → iteration 2: llm (final answer).
      expect(kinds).toEqual(['llm', 'tool', 'llm']);
      expect(run.steps.every((s) => s.ok)).toBe(true);
      expect(run.steps.every((s) => s.durationMs >= 0)).toBe(true);
      expect(run.steps.find((s) => s.kind === 'tool')!.name).toBe('tool:adder');
    } finally {
      runtime.close();
    }
  });

  it('marks tool steps failed when the handler throws, and still ends the run', async () => {
    const telemetry = new TelemetryCollector();
    const boom: ToolDefinition = {
      name: 'boom',
      description: 'Always throws',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('kaput');
      },
    };
    const provider = new MockProvider([
      {
        toolCalls: [{ id: 'c1', name: 'boom', args: {} }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: 'it failed but the turn continued',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      },
    ]);
    const runtime = makeRuntime(telemetry, [boom], provider);
    try {
      await runtime.runTurn({ bot: testBot({ tools: ['boom'] }), message: 'go', onEvent: noop });
      const run = telemetry.listRuns(10)[0]!;
      const toolStep = run.steps.find((s) => s.kind === 'tool')!;
      expect(toolStep.ok).toBe(false);
      expect(toolStep.errorKind).toBe('ToolError');
      expect(run.status).toBe('ok'); // turn completed; the step failed
      expect(run.errors).toBe(1);
      expect(telemetry.summary().errorRate).toBe(0); // run-level error rate stays 0
    } finally {
      runtime.close();
    }
  });

  it('records nothing when no collector is wired', async () => {
    const provider = new MockProvider([{ content: 'hi', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }]);
    class TestRuntime extends AgentRuntime {
      protected resolveProvider(): MockProvider {
        return provider;
      }
    }
    const runtime = new TestRuntime({
      dbPath: ':memory:',
      skillsDir: '/tmp/agent-runtime-test-skills-missing',
      governance: new FakeGateway(),
      toolRegistry: new Map(),
      defaultProviderId: 'mock',
    });
    try {
      const usage = await runtime.runTurn({ bot: testBot(), message: 'hi', onEvent: noop });
      expect(usage.totalTokens).toBe(2);
    } finally {
      runtime.close();
    }
  });
});

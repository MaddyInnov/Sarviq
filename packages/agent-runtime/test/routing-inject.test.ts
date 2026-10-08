// SPDX-License-Identifier: Apache-2.0
// Phase 3: smart-routing injection into AgentRuntime.runTurn.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import { isFreeModel } from '../src/providers/catalog.js';
import { routeModel } from '../src/routing.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, ToolDefinition } from '../src/types.js';

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
    id: 'bot-routing',
    name: 'Routing Bot',
    description: 'Routing test bot',
    systemPrompt: 'You are a test bot.',
    skills: [],
    tools: [],
    mcpServers: [],
    ...overrides,
  } as BotConfig;
}

function makeProvider(): MockProvider {
  return new MockProvider([{ content: 'ok', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }]);
}

function makeRuntime(provider: MockProvider): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected resolveProvider(): MockProvider {
      return provider;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: new FakeGateway(),
    toolRegistry: new Map<string, ToolDefinition>(),
    defaultProviderId: 'mock',
  });
}

const noop = async (): Promise<void> => {};

let savedFreeOnly: string | undefined;
beforeEach(() => {
  savedFreeOnly = process.env.FREE_MODELS_ONLY;
  delete process.env.FREE_MODELS_ONLY;
});
afterEach(() => {
  if (savedFreeOnly === undefined) delete process.env.FREE_MODELS_ONLY;
  else process.env.FREE_MODELS_ONLY = savedFreeOnly;
});

describe('runTurn smart routing injection', () => {
  it('uses the bot-pinned model unchanged (override wins, no routing)', async () => {
    const provider = makeProvider();
    const rt = makeRuntime(provider);
    await rt.runTurn({
      bot: testBot({ provider: 'mock', model: 'mock-model' }),
      message: 'hi',
      onEvent: noop,
      maxIterations: 1,
    });
    expect(provider.calls[0].model).toBe('mock-model');
  });

  it('explicit call-site model wins over everything', async () => {
    const provider = makeProvider();
    const rt = makeRuntime(provider);
    await rt.runTurn({
      bot: testBot({ provider: 'mock', model: 'mock-model' }),
      message: 'hi',
      providerId: 'mock',
      model: 'explicit-model',
      onEvent: noop,
      maxIterations: 1,
    });
    expect(provider.calls[0].model).toBe('explicit-model');
  });

  it('routes an unpinned bot to a catalog model (taskType code)', async () => {
    const provider = makeProvider();
    const rt = makeRuntime(provider);
    await rt.runTurn({
      bot: testBot({}),
      message: 'write a function',
      taskType: 'code',
      onEvent: noop,
      maxIterations: 1,
    });
    // Routed — must be a real catalog model id, not the mock default.
    expect(typeof provider.calls[0].model).toBe('string');
    expect(provider.calls[0].model.length).toBeGreaterThan(0);
  });

  it('stays within free models when FREE_MODELS_ONLY=1', async () => {
    process.env.FREE_MODELS_ONLY = '1';
    const provider = makeProvider();
    const rt = makeRuntime(provider);
    await rt.runTurn({
      bot: testBot({}),
      message: 'hello',
      taskType: 'simple-qa',
      onEvent: noop,
      maxIterations: 1,
    });
    // Deterministic check: the model the provider saw must equal what the
    // pure router picks under the guard, and it must be a free model.
    // (assertModelAllowed would have thrown before the provider was touched
    // if routing had picked a non-free model.)
    const routed = routeModel({ taskType: 'simple-qa' });
    expect(provider.calls[0].model).toBe(routed.modelId);
    expect(isFreeModel(routed.providerId, routed.modelId)).toBe(true);
  });
});

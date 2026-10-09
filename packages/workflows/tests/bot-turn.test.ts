// SPDX-License-Identifier: Apache-2.0
// Tests for the 'bot-turn' workflow node type (feature interconnection,
// workflow → bot): runs a bot turn as a node, stores { text, sessionId },
// and supports thread continuity via config.sessionId.

import { describe, expect, it } from 'vitest';
import type { AgentRuntime, BotConfig, StreamEvent, TokenUsage } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { WorkflowRunner } from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

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

interface TurnCall {
  botId: string;
  sessionId: string;
  message: string;
}

function makeRunner(text = 'bot says hi'): { runner: WorkflowRunner; calls: TurnCall[] } {
  const calls: TurnCall[] = [];
  const runtime = {
    runTurn: async (options: {
      bot: BotConfig;
      message: string;
      sessionId?: string;
      onEvent?: (e: StreamEvent) => void | Promise<void>;
    }): Promise<TokenUsage> => {
      calls.push({ botId: options.bot.id, sessionId: options.sessionId ?? '', message: options.message });
      await options.onEvent?.({ type: 'token', content: text } as StreamEvent);
      return TEST_USAGE;
    },
  } as AgentRuntime;
  const governance = {
    evaluate: async () => ({ effect: 'allow' as const }),
  } as unknown as GovernanceGateway;
  const runner = new WorkflowRunner({
    dbPath: ':memory:',
    agentRuntime: runtime,
    governance,
    tools: new Map(),
    bots: new Map([['bot-1', TEST_BOT]]),
  });
  return { runner, calls };
}

function defWithBotTurn(nodes: WorkflowDefinition['nodes']): WorkflowDefinition {
  const nodesAll: WorkflowDefinition['nodes'] = [
    { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
    ...nodes,
  ];
  const edges: [string, string][] = nodes.map((n, i) => [
    i === 0 ? 'trigger' : nodes[i - 1]!.id,
    n.id,
  ]);
  return { id: 'wf-bot-turn', name: 'bot-turn test', nodes: nodesAll, edges };
}

describe('bot-turn node', () => {
  it('runs a bot turn and stores { text, sessionId }', async () => {
    const { runner, calls } = makeRunner('hello from bot');
    runner.register(
      defWithBotTurn([
        { id: 'turn', type: 'bot-turn', name: 'Ask bot', config: { botId: 'bot-1', prompt: 'say hi' } },
      ]),
    );
    const started = await runner.startRun('wf-bot-turn', {});
    const run = await runner.awaitRun(started.id, 10_000);
    expect(run.status).toBe('succeeded');
    const out = run.nodeStates['turn']?.output as { text: string; sessionId: string };
    expect(out.text).toBe('hello from bot');
    expect(out.sessionId).toBe(`workflow:${started.id}:turn`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.botId).toBe('bot-1');
    expect(calls[0]!.message).toBe('say hi');
    runner.close();
  });

  it('continues an existing thread when config.sessionId is set', async () => {
    const { runner, calls } = makeRunner('continued');
    runner.register(
      defWithBotTurn([
        { id: 't1', type: 'bot-turn', name: 'First', config: { botId: 'bot-1', prompt: 'one', sessionId: 'thread-42' } },
        { id: 't2', type: 'bot-turn', name: 'Second', config: { botId: 'bot-1', prompt: 'two: {{nodes.t1.output.text}}', sessionId: 'thread-42' } },
      ]),
    );
    const started = await runner.startRun('wf-bot-turn', {});
    const run = await runner.awaitRun(started.id, 10_000);
    expect(run.status).toBe('succeeded');
    expect(calls.map((c) => c.sessionId)).toEqual(['thread-42', 'thread-42']);
    // Template interpolation of the previous bot-turn's output works.
    expect(calls[1]!.message).toBe('two: continued');
    runner.close();
  });

  it('fails clearly on unknown bot / missing botId', async () => {
    const { runner } = makeRunner();
    runner.register(
      defWithBotTurn([{ id: 'bad', type: 'bot-turn', name: 'Bad', config: { botId: 'nope', prompt: 'x' } }]),
    );
    const started = await runner.startRun('wf-bot-turn', {});
    const run = await runner.awaitRun(started.id, 10_000);
    expect(run.status).toBe('failed');
    expect(run.nodeStates['bad']?.error).toMatch(/unknown bot/);
    runner.close();

    const { runner: runner2 } = makeRunner();
    runner2.register(
      defWithBotTurn([{ id: 'bad2', type: 'bot-turn', name: 'Bad2', config: { prompt: 'x' } }]),
    );
    const started2 = await runner2.startRun('wf-bot-turn', {});
    const run2 = await runner2.awaitRun(started2.id, 10_000);
    expect(run2.status).toBe('failed');
    expect(run2.nodeStates['bad2']?.error).toMatch(/config\.botId is required/);
    runner2.close();
  });
});

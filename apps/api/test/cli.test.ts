// SPDX-License-Identifier: Apache-2.0
// Tests for the pipe/JSON CLI mode (apps/api/src/cli.ts):
// - parseChatArgs: defaults, flags, mutual --json/--pretty, usage errors
// - runChatCli with an injected runtime stub: never boots a real server,
//   never touches the network; asserts JSON/pretty output shapes, exit
//   codes, and error paths.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatArgError, parseChatArgs, runChatCli } from '../src/cli.js';
import type { ChatCliDeps, ChatCliRuntime } from '../src/cli.js';
import type { BotConfig, StreamEvent } from '@mvp/agent-runtime';

const BOT: BotConfig = {
  id: 'helper',
  name: 'Helper',
  description: 'test bot',
  systemPrompt: 'You are a test bot.',
  provider: 'mock',
  model: 'mock-model',
  skills: [],
  tools: [],
  mcpServers: [],
};

const USAGE = { promptTokens: 5, completionTokens: 5, totalTokens: 10 };

function stubRuntime(turn: (onEvent: (e: StreamEvent) => void | Promise<void>) => Promise<void> | void = async (onEvent) => {
  await onEvent({ type: 'token', content: 'Hello' });
  await onEvent({ type: 'token', content: ' there' });
  await onEvent({ type: 'done', usage: { ...USAGE } });
}): { runtime: ChatCliRuntime; seen: { message?: string; bot?: BotConfig }; closed: () => boolean } {
  const seen: { message?: string; bot?: BotConfig } = {};
  let isClosed = false;
  const runtime: ChatCliRuntime = {
    async runTurn(opts) {
      seen.message = opts.message;
      seen.bot = opts.bot;
      await turn(opts.onEvent);
      return { usage: { ...USAGE }, sessionId: 'sess-test-1' };
    },
    async close() {
      isClosed = true;
    },
  };
  return { runtime, seen, closed: () => isClosed };
}

function depsWith(overrides: Partial<ChatCliDeps> = {}): { deps: ChatCliDeps; stub: ReturnType<typeof stubRuntime> } {
  const stub = stubRuntime();
  const deps: ChatCliDeps = {
    findBot: async (id) => (id === 'helper' ? BOT : undefined),
    listBots: async () => [BOT],
    buildRuntime: async () => stub.runtime,
    readPipedPrompt: async () => 'hello from pipe',
    ...overrides,
  };
  return { deps, stub };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function captureConsole() {
  const logs: string[] = [];
  const errs: string[] = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  return { logs, errs };
}

afterEach(() => {
  logSpy?.mockRestore();
  errSpy?.mockRestore();
});

describe('parseChatArgs', () => {
  it('applies defaults (bot helper, pretty output)', () => {
    expect(parseChatArgs(['chat'])).toMatchObject({
      botId: 'helper',
      json: false,
      pretty: true,
      help: false,
    });
  });

  it('accepts argv without the leading "chat" too', () => {
    const a = parseChatArgs(['--bot', 'coder', '--json']);
    expect(a.botId).toBe('coder');
    expect(a.json).toBe(true);
    expect(a.pretty).toBe(false);
  });

  it('parses message/provider/model flags', () => {
    const a = parseChatArgs(['chat', '--message', 'hi', '--provider', 'groq', '--model', 'm']);
    expect(a).toMatchObject({ message: 'hi', providerId: 'groq', model: 'm' });
  });

  it('--pretty after --json wins (last flag wins)', () => {
    const a = parseChatArgs(['chat', '--json', '--pretty']);
    expect(a.json).toBe(false);
    expect(a.pretty).toBe(true);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseChatArgs(['chat', '--bogus'])).toThrow(ChatArgError);
    expect(() => parseChatArgs(['chat', '--message'])).toThrow(ChatArgError);
    expect(() => parseChatArgs(['chat', '--bot'])).toThrow(ChatArgError);
  });

  it('parses --help', () => {
    expect(parseChatArgs(['chat', '--help']).help).toBe(true);
  });
});

describe('runChatCli', () => {
  it('--help prints usage and exits 0 without touching deps', async () => {
    const { logs } = captureConsole();
    const code = await runChatCli(['chat', '--help'], {
      buildRuntime: () => {
        throw new Error('must not build a runtime for --help');
      },
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Usage: mvp-server chat');
  });

  it('--json prints a single JSON object { content, usage, sessionId }', async () => {
    const { logs } = captureConsole();
    const { deps, stub } = depsWith();
    const code = await runChatCli(['chat', '--bot', 'helper', '--json'], deps);
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    const obj = JSON.parse(logs[0]!);
    expect(obj).toEqual({
      content: 'Hello there',
      usage: USAGE,
      sessionId: 'sess-test-1',
    });
    expect(stub.seen.message).toBe('hello from pipe');
    expect(stub.seen.bot?.id).toBe('helper');
    expect(stub.closed()).toBe(true);
  });

  it('pretty mode prints content plus a usage line', async () => {
    const { logs } = captureConsole();
    const { deps } = depsWith();
    const code = await runChatCli(['chat', '--message', 'explicit prompt'], deps);
    expect(code).toBe(0);
    expect(logs[0]).toBe('Hello there');
    expect(logs[1]).toMatch(/10 tokens/);
    expect(logs[1]).toMatch(/sess-test-1/);
  });

  it('prefers --message over piped stdin', async () => {
    captureConsole();
    const { deps, stub } = depsWith({ readPipedPrompt: async () => 'piped text' });
    await runChatCli(['chat', '--message', 'flag text'], deps);
    expect(stub.seen.message).toBe('flag text');
  });

  it('exits 1 with an error when there is no prompt', async () => {
    const { errs } = captureConsole();
    const { deps } = depsWith({ readPipedPrompt: async () => '   ' });
    const code = await runChatCli(['chat'], deps);
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/no prompt/);
  });

  it('exits 1 for an unknown bot and lists available bots', async () => {
    const { errs } = captureConsole();
    const { deps } = depsWith();
    const code = await runChatCli(['chat', '--bot', 'nope', '--message', 'hi'], deps);
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/unknown bot "nope"/);
    expect(errs.join('\n')).toMatch(/helper/);
  });

  it('prints { error } as the single JSON line when the turn fails (json mode)', async () => {
    const { logs } = captureConsole();
    const failing: ChatCliRuntime = {
      async runTurn() {
        throw new Error('provider down');
      },
      async close() {},
    };
    const { deps } = depsWith({ buildRuntime: async () => failing });
    const code = await runChatCli(['chat', '--json', '--message', 'hi'], deps);
    expect(code).toBe(1);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual({ error: 'provider down' });
  });

  it('reports approval requests to stderr in non-interactive mode', async () => {
    const { errs } = captureConsole();
    const stub = stubRuntime(async (onEvent) => {
      await onEvent({
        type: 'approval_required',
        approvalId: 'appr_1',
        call: { id: 'c1', name: 'run_command', args: {} },
      });
      await onEvent({ type: 'token', content: 'done-ish' });
      await onEvent({ type: 'done', usage: { ...USAGE } });
    });
    const { deps } = depsWith({ buildRuntime: async () => stub.runtime });
    const code = await runChatCli(['chat', '--message', 'hi'], deps);
    expect(code).toBe(0);
    expect(errs.join('\n')).toMatch(/approval requested for tool "run_command"/);
    expect(errs.join('\n')).toMatch(/non-interactive/);
  });

  it('propagates provider/model overrides to the runtime', async () => {
    captureConsole();
    let captured: { providerId?: string; model?: string } = {};
    const runtime: ChatCliRuntime = {
      async runTurn(opts) {
        captured = { providerId: opts.providerId, model: opts.model };
        return { usage: { ...USAGE }, sessionId: 's' };
      },
      async close() {},
    };
    const { deps } = depsWith({ buildRuntime: async () => runtime });
    await runChatCli(['chat', '--message', 'hi', '--provider', 'groq', '--model', 'm1'], deps);
    expect(captured).toEqual({ providerId: 'groq', model: 'm1' });
  });
});

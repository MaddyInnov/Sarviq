// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';

const ENV_KEYS = ['GROQ_API_KEY', 'PROVIDERS_FILE'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('OpenAICompatibleProvider retry', () => {
  it('retries once on 429 then streams the successful response', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      providerId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'test-key',
    });
    const tokens: string[] = [];
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'openai/gpt-oss-20b',
      onToken: (t) => tokens.push(t),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('Hello world');
    expect(tokens.join('')).toBe('Hello world');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
  });

  it('accumulates streamed tool_calls by index', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_","arguments":""}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"{\\"city\\""}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Paris\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sse, { status: 200 })));

    const provider = new OpenAICompatibleProvider({
      providerId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'test-key',
    });
    const result = await provider.chat(
      [{ role: 'user', content: 'weather?' }],
      [{ name: 'get_weather', description: 'weather', parameters: {}, handler: async () => ({}) }],
      { model: 'openai/gpt-oss-20b' },
    );
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', args: { city: 'Paris' } }]);
  });

  it('does not retry on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      providerId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'bad',
    });
    await expect(provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'm' })).rejects.toThrow(
      /401/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAICompatibleProvider listModels with empty baseUrl', () => {
  it('returns the (empty) catalog list instead of failing', async () => {
    const provider = new OpenAICompatibleProvider({
      providerId: 'omnirush',
      baseUrl: '',
      apiKey: 'own-key',
    });
    await expect(provider.listModels()).resolves.toEqual([]);
  });
});

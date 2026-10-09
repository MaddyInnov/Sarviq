// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, afterEach } from 'vitest';
import { OllamaProvider, ollamaHost } from '../src/providers/ollama.js';
import { createProvider } from '../src/providers/factory.js';

const realFetch = globalThis.fetch;
const realEnv = process.env.OLLAMA_HOST;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  if (realEnv === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = realEnv;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ollamaHost', () => {
  it('defaults to http://localhost:11434', () => {
    delete process.env.OLLAMA_HOST;
    expect(ollamaHost()).toBe('http://localhost:11434');
  });
  it('honors OLLAMA_HOST and strips trailing slashes', () => {
    process.env.OLLAMA_HOST = 'http://gpu-box:11434///';
    expect(ollamaHost()).toBe('http://gpu-box:11434');
  });
});

describe('OllamaProvider.listModels', () => {
  it('reads /api/tags and marks models free', async () => {
    delete process.env.OLLAMA_HOST;
    globalThis.fetch = (async (url: unknown) => {
      expect(String(url)).toBe('http://localhost:11434/api/tags');
      return jsonResponse({
        models: [
          { name: 'llama3.1:8b', model: 'llama3.1:8b', details: { parameter_size: '8B' } },
          { name: 'qwen2.5:7b', model: 'qwen2.5:7b', details: {} },
        ],
      });
    }) as typeof fetch;
    const models = await new OllamaProvider().listModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: 'llama3.1:8b', free: true });
    expect(models[0].name).toContain('8B');
  });

  it('returns [] when Ollama is not running', async () => {
    delete process.env.OLLAMA_HOST;
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    expect(await new OllamaProvider().listModels()).toEqual([]);
  });
});

describe('OllamaProvider.chat', () => {
  it('posts to /v1/chat/completions without requiring a key', async () => {
    delete process.env.OLLAMA_HOST;
    let seenUrl = '';
    let seenAuth: string | null = null;
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>)?.['Authorization'] ?? null;
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
    const res = await new OllamaProvider().chat([{ role: 'user', content: 'hi' }], [], { model: 'llama3.1:8b' });
    expect(seenUrl).toBe('http://localhost:11434/v1/chat/completions');
    expect(res.content).toBe('hi');
    // Auth header is a dummy — Ollama ignores it; the point is no real key exists.
    expect(seenAuth).toBeTruthy();
  });

  it('gives a clear error when Ollama is unreachable', async () => {
    delete process.env.OLLAMA_HOST;
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    await expect(
      new OllamaProvider().chat([{ role: 'user', content: 'hi' }], [], { model: 'llama3.1:8b' }),
    ).rejects.toThrow(/Ollama is not reachable at http:\/\/localhost:11434/);
  });

  it('gives a clear error when the model lacks tool support', async () => {
    delete process.env.OLLAMA_HOST;
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'model "x" does not support tools' }, 400)) as typeof fetch;
    await expect(
      new OllamaProvider().chat([{ role: 'user', content: 'hi' }], [{ name: 't', description: 'd', parameters: {} }], {
        model: 'x',
      }),
    ).rejects.toThrow(/does not support tool calling/);
  });
});

describe('factory createProvider("ollama")', () => {
  it('builds an OllamaProvider with no API key configured', () => {
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_API_KEY;
    const p = createProvider('ollama');
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.providerId).toBe('ollama');
  });
});

// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import {
  getRateLimit,
  parseAnthropicRateLimitHeaders,
  parseOpenAIRateLimitHeaders,
  parseResetSeconds,
  recordRateLimit,
  resetRateLimits,
} from '../src/providers/rate-limit.js';

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

beforeEach(() => resetRateLimits());
afterEach(() => {
  vi.unstubAllGlobals();
  resetRateLimits();
});

describe('parseResetSeconds', () => {
  it('parses bare seconds', () => {
    expect(parseResetSeconds('42')).toBe(42);
    expect(parseResetSeconds('1.5')).toBe(1.5);
    expect(parseResetSeconds('  7  ')).toBe(7);
  });
  it('parses duration strings', () => {
    expect(parseResetSeconds('1s')).toBe(1);
    expect(parseResetSeconds('500ms')).toBe(0.5);
    expect(parseResetSeconds('6m0s')).toBe(360);
    expect(parseResetSeconds('1h2m3s')).toBe(3723);
    expect(parseResetSeconds('2m')).toBe(120);
  });
  it('rejects absent or malformed values', () => {
    expect(parseResetSeconds(null)).toBeUndefined();
    expect(parseResetSeconds('')).toBeUndefined();
    expect(parseResetSeconds('abc')).toBeUndefined();
    expect(parseResetSeconds('1x')).toBeUndefined();
    expect(parseResetSeconds('soon')).toBeUndefined();
  });
});

describe('parseOpenAIRateLimitHeaders', () => {
  it('parses a full Groq-style header set', () => {
    const snap = parseOpenAIRateLimitHeaders(
      headers({
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '28',
        'x-ratelimit-reset-requests': '1.2s',
        'x-ratelimit-limit-tokens': '200000',
        'x-ratelimit-remaining-tokens': '184002',
        'x-ratelimit-reset-tokens': '6m0s',
      }),
    );
    expect(snap).not.toBeNull();
    expect(snap?.limitRequests).toBe(30);
    expect(snap?.remainingRequests).toBe(28);
    expect(snap?.limitTokens).toBe(200000);
    expect(snap?.remainingTokens).toBe(184002);
    // resetAt ≈ now + 1.2s (request reset wins over token reset)
    const resetMs = new Date(snap?.resetAt ?? '').getTime() - Date.now();
    expect(resetMs).toBeGreaterThan(0);
    expect(resetMs).toBeLessThan(5000);
  });

  it('returns null when no rate-limit headers are present', () => {
    expect(parseOpenAIRateLimitHeaders(headers({ 'content-type': 'application/json' }))).toBeNull();
    expect(parseOpenAIRateLimitHeaders(headers({}))).toBeNull();
  });

  it('ignores malformed numeric values but keeps the valid ones', () => {
    const snap = parseOpenAIRateLimitHeaders(
      headers({
        'x-ratelimit-remaining-requests': 'not-a-number',
        'x-ratelimit-limit-requests': '30',
      }),
    );
    expect(snap?.remainingRequests).toBeUndefined();
    expect(snap?.limitRequests).toBe(30);
  });

  it('header names are case-insensitive', () => {
    const snap = parseOpenAIRateLimitHeaders(
      headers({ 'X-RateLimit-Remaining-Requests': '12' }),
    );
    expect(snap?.remainingRequests).toBe(12);
  });
});

describe('parseAnthropicRateLimitHeaders', () => {
  it('parses a full Anthropic header set with RFC 3339 resets', () => {
    const reset = '2026-10-08T23:59:00.000Z';
    const snap = parseAnthropicRateLimitHeaders(
      headers({
        'anthropic-ratelimit-requests-limit': '1000',
        'anthropic-ratelimit-requests-remaining': '999',
        'anthropic-ratelimit-requests-reset': reset,
        'anthropic-ratelimit-tokens-limit': '1000000',
        'anthropic-ratelimit-tokens-remaining': '987654',
      }),
    );
    expect(snap?.limitRequests).toBe(1000);
    expect(snap?.remainingRequests).toBe(999);
    expect(snap?.limitTokens).toBe(1000000);
    expect(snap?.remainingTokens).toBe(987654);
    expect(snap?.resetAt).toBe(reset);
  });

  it('returns null when no rate-limit headers are present', () => {
    expect(parseAnthropicRateLimitHeaders(headers({}))).toBeNull();
  });

  it('ignores an unparseable reset timestamp', () => {
    const snap = parseAnthropicRateLimitHeaders(
      headers({
        'anthropic-ratelimit-requests-remaining': '5',
        'anthropic-ratelimit-requests-reset': 'whenever',
      }),
    );
    expect(snap?.remainingRequests).toBe(5);
    expect(snap?.resetAt).toBeUndefined();
  });
});

describe('rate-limit registry', () => {
  it('merges snapshots per provider id, keeping prior fields', () => {
    recordRateLimit('groq', { limitRequests: 30, remainingRequests: 28 });
    recordRateLimit('groq', { remainingTokens: 1000 });
    expect(getRateLimit('groq')).toEqual({
      limitRequests: 30,
      remainingRequests: 28,
      remainingTokens: 1000,
    });
  });

  it('keeps providers separate and returns null for unknown ids', () => {
    recordRateLimit('groq', { remainingRequests: 1 });
    expect(getRateLimit('openrouter')).toBeNull();
    expect(getRateLimit('groq')?.remainingRequests).toBe(1);
  });
});

describe('driver header capture', () => {
  it('OpenAICompatibleProvider.chat records x-ratelimit-* headers', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(sse, {
          status: 200,
          headers: {
            'x-ratelimit-limit-requests': '30',
            'x-ratelimit-remaining-requests': '27',
          },
        }),
      ),
    );
    const provider = new OpenAICompatibleProvider({
      providerId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'test-key',
    });
    await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-oss-20b' });
    expect(getRateLimit('groq')).toMatchObject({ limitRequests: 30, remainingRequests: 27 });
  });

  it('OpenAICompatibleProvider.chat degrades gracefully with no headers', async () => {
    const sse = 'data: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sse, { status: 200 })));
    const provider = new OpenAICompatibleProvider({
      providerId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
    });
    await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'x' });
    expect(getRateLimit('openrouter')).toBeNull();
  });

  it('AnthropicProvider.chat records anthropic-ratelimit-* headers under its provider id', async () => {
    const body = JSON.stringify({
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: {
            'anthropic-ratelimit-requests-limit': '1000',
            'anthropic-ratelimit-requests-remaining': '998',
          },
        }),
      ),
    );
    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test-key',
      providerId: 'claude-subscription',
    });
    await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'claude-sonnet-4-5' });
    expect(getRateLimit('claude-subscription')).toMatchObject({
      limitRequests: 1000,
      remainingRequests: 998,
    });
    // …and not under the plain 'anthropic' id.
    expect(getRateLimit('anthropic')).toBeNull();
  });
});

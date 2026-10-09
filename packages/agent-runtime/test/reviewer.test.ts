// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { reviewToolCall } from '../src/reviewer.js';
import type { LLMProvider } from '../src/types.js';

function mockProvider(content: string): LLMProvider {
  return {
    providerId: 'mock',
    chat: vi.fn().mockResolvedValue({ content, toolCalls: [], usage: { input: 0, output: 0 } }),
    listModels: vi.fn().mockResolvedValue([]),
  } as unknown as LLMProvider;
}

describe('reviewer', () => {
  it('YES → allow', async () => {
    process.env.REVIEWER_MODEL = 'mock/test-model';
    const res = await reviewToolCall(mockProvider('YES — routine file read'), {
      id: '1',
      name: 'read_file',
      args: { path: 'notes.md' },
    });
    expect(res.verdict).toBe('yes');
    delete process.env.REVIEWER_MODEL;
  });

  it('NO → escalate', async () => {
    process.env.REVIEWER_MODEL = 'mock/test-model';
    const res = await reviewToolCall(mockProvider('NO — deletes data'), {
      id: '1',
      name: 'delete_file',
      args: { path: 'important.md' },
    });
    expect(res.verdict).toBe('no');
    delete process.env.REVIEWER_MODEL;
  });

  it('uncertain → no (fail-safe)', async () => {
    process.env.REVIEWER_MODEL = 'mock/test-model';
    const res = await reviewToolCall(mockProvider('Maybe, not sure'), {
      id: '1',
      name: 'run_command',
      args: { command: 'ls' },
    });
    expect(res.verdict).toBe('no');
    delete process.env.REVIEWER_MODEL;
  });

  it('redacts secrets before sending to reviewer', async () => {
    process.env.REVIEWER_MODEL = 'mock/test-model';
    const chat = vi.fn().mockResolvedValue({ content: 'YES — fine', toolCalls: [], usage: { input: 0, output: 0 } });
    const provider = { providerId: 'mock', chat, listModels: vi.fn() } as unknown as LLMProvider;
    await reviewToolCall(provider, {
      id: '1',
      name: 'http_call',
      args: { apiToken: 'super-secret-123' },
    });
    const sentPrompt = (chat.mock.calls[0] as any[])[0][0].content as string;
    expect(sentPrompt).not.toContain('super-secret-123');
    expect(sentPrompt).toContain('[REDACTED]');
    delete process.env.REVIEWER_MODEL;
  });

  it('provider error → skip (escalate to human)', async () => {
    process.env.REVIEWER_MODEL = 'mock/test-model';
    const provider = {
      providerId: 'mock',
      chat: vi.fn().mockRejectedValue(new Error('boom')),
      listModels: vi.fn(),
    } as unknown as LLMProvider;
    const res = await reviewToolCall(provider, { id: '1', name: 'x', args: {} });
    expect(res.verdict).toBe('skip');
    delete process.env.REVIEWER_MODEL;
  });
});

// SPDX-License-Identifier: Apache-2.0
// Fast message router: deterministic keyword/topic routing, no LLM.

import { describe, expect, it } from 'vitest';
import { TOPIC_KEYWORDS, routeMessage } from '../src/message-router.js';
import type { RoutableBot } from '../src/message-router.js';

const bots: RoutableBot[] = [
  { id: 'coder', name: 'Coder', description: 'writes code and fixes bugs', keywords: ['pull request', 'typescript'] },
  { id: 'writer', name: 'Writer', description: 'drafts blog posts and essays' },
  { id: 'money', name: 'Money', description: 'budgets and investments', keywords: ['invoice'] },
];

describe('routeMessage', () => {
  it('routes code questions to the coder bot', () => {
    const r = routeMessage('there is a bug in my typescript function, can you debug it?', bots);
    expect(r.botId).toBe('coder');
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.reason).toContain('Coder');
  });

  it('routes writing questions to the writer bot', () => {
    const r = routeMessage('help me draft a blog post about essays', bots);
    expect(r.botId).toBe('writer');
  });

  it('routes finance questions to the money bot', () => {
    const r = routeMessage('how should I invest my savings this year?', bots);
    expect(r.botId).toBe('money');
  });

  it('gives phrase keywords a bonus', () => {
    const r = routeMessage('please review this pull request', bots);
    expect(r.botId).toBe('coder');
    expect(r.reason).toContain('pull request');
  });

  it('is deterministic: same input always yields the same route', () => {
    const text = 'debug the failing test in the checkout flow';
    const a = routeMessage(text, bots);
    const b = routeMessage(text, bots);
    expect(a).toEqual(b);
  });

  it('falls back to the first bot with confidence 0 when nothing matches', () => {
    const r = routeMessage('zxqw asdf jklm', bots);
    expect(r.botId).toBe('coder');
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/fell back/i);
  });

  it('returns an empty botId when there are no bots', () => {
    const r = routeMessage('hello', []);
    expect(r.botId).toBe('');
    expect(r.confidence).toBe(0);
  });

  it('resolves ties to the earliest bot (stable)', () => {
    const tied: RoutableBot[] = [
      { id: 'a', name: 'Helper', description: 'general help' },
      { id: 'b', name: 'Helper', description: 'general help' },
    ];
    const r = routeMessage('help me please', tied);
    expect(r.botId).toBe('a');
  });

  it('per-bot keywords bias routing without touching name/description', () => {
    const plain: RoutableBot[] = [
      { id: 'gen', name: 'General', description: 'general assistant' },
      { id: 'bill', name: 'Helper', description: 'general assistant', keywords: ['invoice', 'refund'] },
    ];
    const r = routeMessage('where is my invoice refund?', plain);
    expect(r.botId).toBe('bill');
  });

  it('confidence is the winner share of total score, bounded 0..1', () => {
    const r = routeMessage('fix this bug and write a blog post about the bug fix', bots);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('exposes the built-in topic vocabulary', () => {
    expect(Object.keys(TOPIC_KEYWORDS)).toEqual(
      expect.arrayContaining(['code', 'writing', 'finance', 'research', 'health', 'travel', 'music', 'productivity', 'shopping']),
    );
  });
});

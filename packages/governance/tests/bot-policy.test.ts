// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../src/default-policy.js';
import { mergeBotPolicy } from '../src/bot-policy.js';
import type { Policy } from '../src/types.js';

describe('mergeBotPolicy', () => {
  it('prepends bot rules before global rules, keeping the global defaultEffect', () => {
    const merged = mergeBotPolicy(DEFAULT_POLICY, {
      rules: [{ id: 'bot-deny', toolPattern: '^run_command$', effect: 'deny', reason: 'bot says no' }],
    });
    expect(merged.defaultEffect).toBe(DEFAULT_POLICY.defaultEffect);
    expect(merged.rules[0]?.id).toBe('bot-deny');
    expect(merged.rules[0]?.effect).toBe('deny');
    expect(merged.rules.length).toBe(DEFAULT_POLICY.rules.length + 1);
    // Global rules follow, in order.
    expect(merged.rules[1]?.id).toBe(DEFAULT_POLICY.rules[0]?.id);
  });

  it('does not mutate the inputs', () => {
    const before = JSON.stringify(DEFAULT_POLICY);
    mergeBotPolicy(DEFAULT_POLICY, { rules: [{ id: 'x', toolPattern: 'y', effect: 'allow' }] });
    expect(JSON.stringify(DEFAULT_POLICY)).toBe(before);
  });

  it('with no bot policy returns an equivalent global policy', () => {
    const merged = mergeBotPolicy(DEFAULT_POLICY);
    expect(merged).toEqual(DEFAULT_POLICY);
    expect(merged.rules).not.toBe(DEFAULT_POLICY.rules); // fresh array
  });

  it('bot rules win first-match-wins: a bot allow beats the global mcp-require-approval', () => {
    const global: Policy = {
      defaultEffect: 'require-approval',
      rules: [{ id: 'mcp-require-approval', toolPattern: '^mcp:', effect: 'require-approval' }],
    };
    const merged = mergeBotPolicy(global, {
      rules: [{ id: 'allow-fetch', toolPattern: '^mcp:fetch:', effect: 'allow' }],
    });
    // First matching rule for "mcp:fetch:read" is the bot's allow.
    const winner = merged.rules.find((r) => new RegExp(r.toolPattern, 'i').test('mcp:fetch:read'));
    expect(winner?.id).toBe('allow-fetch');
    expect(winner?.effect).toBe('allow');
    // A different MCP server still hits the global rule.
    const other = merged.rules.find((r) => new RegExp(r.toolPattern, 'i').test('mcp:other:read'));
    expect(other?.id).toBe('mcp-require-approval');
  });

  it('a bot deny can tighten a globally-allowed tool', () => {
    const merged = mergeBotPolicy(DEFAULT_POLICY, {
      rules: [{ id: 'bot-deny-reads', toolPattern: '^web_search$', effect: 'deny' }],
    });
    const winner = merged.rules.find((r) => new RegExp(r.toolPattern, 'i').test('web_search'));
    expect(winner?.id).toBe('bot-deny-reads');
    expect(winner?.effect).toBe('deny');
  });
});

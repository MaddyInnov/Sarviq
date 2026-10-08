// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { addUsage, emptyUsage } from '../src/types.js';
import { CONTEXT_WARN_PCT, contextMeter, formatTokens } from '../src/usage.js';

describe('formatTokens', () => {
  it('renders small counts exactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });
  it('compacts thousands', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1240)).toBe('1.2k');
    expect(formatTokens(100000)).toBe('100k');
    expect(formatTokens(131072)).toBe('131k');
  });
  it('compacts millions', () => {
    expect(formatTokens(2_400_000)).toBe('2.4M');
    expect(formatTokens(1_000_000)).toBe('1M');
  });
  it('degrades on bad input', () => {
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(NaN)).toBe('0');
  });
});

describe('contextMeter', () => {
  it('computes pct and warns at 80%+', () => {
    const calm = contextMeter(12400, 131072);
    expect(calm?.pct).toBeCloseTo(9.46, 1);
    expect(calm?.warn).toBe(false);
    const hot = contextMeter(110000, 131072);
    expect(hot?.warn).toBe(true);
    expect(CONTEXT_WARN_PCT).toBe(80);
  });
  it('returns null when the context length is unknown', () => {
    expect(contextMeter(100, undefined)).toBeNull();
    expect(contextMeter(100, 0)).toBeNull();
    expect(contextMeter(100, -1)).toBeNull();
  });
});

describe('usage accumulation', () => {
  it('addUsage sums all fields', () => {
    const a = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
    const b = { promptTokens: 50, completionTokens: 70, totalTokens: 120 };
    expect(addUsage(a, b)).toEqual({ promptTokens: 150, completionTokens: 90, totalTokens: 240 });
    expect(addUsage(emptyUsage(), a)).toEqual(a);
  });
});

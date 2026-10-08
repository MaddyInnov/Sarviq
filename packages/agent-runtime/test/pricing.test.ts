// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { costOfUsage, MODEL_PRICES, priceOfModel } from '../src/pricing.js';
import type { TokenUsage } from '../src/types.js';

const usage: TokenUsage = { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 };

describe('priceOfModel', () => {
  it('resolves exact providerId/modelId keys', () => {
    const p = priceOfModel('openai', 'gpt-4o');
    expect(p).toBeDefined();
    expect(p?.inputPer1M).toBe(2.5);
    expect(p?.outputPer1M).toBe(10.0);
    expect(p?.estimate).toBe(true);
  });

  it('falls back to a bare modelId', () => {
    const p = priceOfModel('whatever', 'gpt-4o-mini');
    expect(p?.inputPer1M).toBe(0.15);
  });

  it('returns $0 (not an estimate) for catalog free models', () => {
    // opencode-zen models are pinned free:true in catalog.json.
    const p = priceOfModel('opencode-zen', 'big-pickle');
    expect(p).toEqual({ inputPer1M: 0, outputPer1M: 0, estimate: false });
  });

  it('returns $0 for :free / -free suffixed ids even without a catalog entry', () => {
    expect(priceOfModel('openrouter', 'some-model:free')).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
      estimate: false,
    });
    expect(priceOfModel('opencode-zen', 'some-model-free')).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
      estimate: false,
    });
  });

  it('returns undefined for unknown priced models', () => {
    expect(priceOfModel('groq', 'no-such-model')).toBeUndefined();
  });

  it('every table entry is marked estimate:true (public-data caveat)', () => {
    for (const [key, price] of Object.entries(MODEL_PRICES)) {
      expect(price.estimate, key).toBe(true);
    }
  });
});

describe('costOfUsage', () => {
  it('computes input/output/total from per-1M prices', () => {
    const c = costOfUsage('openai', 'gpt-4o', usage);
    expect(c.input).toBeCloseTo(2.5, 10);
    expect(c.output).toBeCloseTo(5.0, 10);
    expect(c.total).toBeCloseTo(7.5, 10);
    expect(c.estimated).toBe(true);
  });

  it('is $0 and not estimated for free models', () => {
    const c = costOfUsage('opencode-zen', 'big-pickle', usage);
    expect(c).toEqual({ input: 0, output: 0, total: 0, estimated: false });
  });

  it('is $0 but estimated for unknown models (honest unknown, not a free claim)', () => {
    const c = costOfUsage('groq', 'no-such-model', usage);
    expect(c.total).toBe(0);
    expect(c.estimated).toBe(true);
  });
});

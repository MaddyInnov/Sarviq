// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { capPct, donutSegments, fmtUsd, sharePct } from './cost';

describe('fmtUsd', () => {
  it('formats dollars with two decimals', () => {
    expect(fmtUsd(12.3)).toBe('$12.30');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(NaN)).toBe('$0.00');
  });
});

describe('sharePct / capPct', () => {
  it('computes shares and guards zero totals', () => {
    expect(sharePct(50, 200)).toBe(25);
    expect(sharePct(10, 0)).toBe(0);
    expect(capPct(120, 100)).toBe(100);
    expect(capPct(50, 100)).toBe(50);
    expect(capPct(10, 0)).toBe(0);
  });
});

describe('donutSegments', () => {
  it('partitions the circle proportionally', () => {
    const segs = donutSegments([50, 50]);
    expect(segs).toHaveLength(2);
    expect(segs[0].length).toBeCloseTo(50);
    expect(segs[1].length).toBeCloseTo(50);
    expect(segs[1].offset).toBeCloseTo(segs[0].offset + 50);
  });

  it('degenerates gracefully on empty input', () => {
    expect(donutSegments([0, 0])).toEqual([
      { length: 0, offset: 0 },
      { length: 0, offset: 0 },
    ]);
  });
});

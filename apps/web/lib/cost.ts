// SPDX-License-Identifier: Apache-2.0
// Pure helpers for the cost dashboard (no DOM — unit-testable).

/** USD money: 12.3 -> "$12.30". */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

/** Share of a total as a 0-100 percentage (0 when total <= 0). */
export function sharePct(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (value / total) * 100));
}

/** Cap fill as a 0-100 percentage, clamped (may hit 100+ visually via .exceeded). */
export function capPct(used: number, cap: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(100, Math.max(0, (used / cap) * 100));
}

export interface DonutSegment {
  /** dash-array length in percent units (0-100) */
  length: number;
  /** dash offset in percent units */
  offset: number;
}

/**
 * Compute stroke-dasharray segments for an SVG circle with
 * pathLength=100: each segment's visible length and offset.
 */
export function donutSegments(values: number[]): DonutSegment[] {
  const total = values.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  if (total <= 0) return values.map(() => ({ length: 0, offset: 0 }));
  let acc = 25; // start at 12 o'clock
  return values.map((v) => {
    const length = sharePct(v, total);
    const seg = { length, offset: acc };
    acc += length;
    return seg;
  });
}

// SPDX-License-Identifier: Apache-2.0
// Regression detection (feature #5): "quietly got worse this week".
// Compares the most recent 7-day window against the prior 7-day window per
// scope (bot or workflow) on three metrics — p50 latency, error rate, and
// cost per run — and flags degradations beyond a threshold.
//
// Thresholds (documented so they can be tuned):
//   windowDays   = 7     — current vs prior 7-day windows
//   thresholdPct = 30    — alert when >30% worse than baseline
//   minSamples   = 10    — each window needs >=10 samples (noise guard)
//   errorAbsPp   = 2     — error-rate alerts additionally need >=2 percentage
//                          points of absolute movement (a 0.1% -> 0.2% jump is
//                          100% relative but meaningless)

import type { MetricSample, RegressionAlert, RegressionMetric } from './types.js';

export interface RegressionOptions {
  /** Days per comparison window. Default 7. */
  windowDays?: number;
  /** Percent-worse threshold that triggers an alert. Default 30. */
  thresholdPct?: number;
  /** Minimum samples required in EACH window. Default 10. */
  minSamples?: number;
  /** Absolute percentage-point guard for error-rate alerts. Default 2. */
  errorAbsPp?: number;
  /** Reference time (ms epoch). Default Date.now(). */
  now?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const METRIC_LABELS: Record<RegressionMetric, string> = {
  'latency-p50': 'p50 latency',
  'error-rate': 'error rate',
  'cost-per-run': 'cost per run',
};

interface WindowStats {
  p50Latency: number | null;
  errorRate: number | null;
  meanCost: number | null;
  samples: number;
}

function statsFor(samples: MetricSample[]): WindowStats {
  const latencies = samples
    .map((s) => s.latencyMs)
    .filter((v): v is number => typeof v === 'number' && v >= 0);
  const costs = samples
    .map((s) => s.costUsd)
    .filter((v): v is number => typeof v === 'number' && v >= 0);
  const errors = samples.filter((s) => s.errored).length;
  return {
    p50Latency: percentile(latencies, 50),
    errorRate: samples.length > 0 ? errors / samples.length : null,
    meanCost: mean(costs),
    samples: samples.length,
  };
}

/**
 * Flag regressions across scopes. Returns alerts sorted by change magnitude
 * (worst first). Pure function — the store feeds it samples.
 */
export function detectRegressions(samples: MetricSample[], opts: RegressionOptions = {}): RegressionAlert[] {
  const windowDays = opts.windowDays ?? 7;
  const thresholdPct = opts.thresholdPct ?? 30;
  const minSamples = opts.minSamples ?? 10;
  const errorAbsPp = opts.errorAbsPp ?? 2;
  const now = opts.now ?? Date.now();

  const windowMs = windowDays * DAY_MS;
  const currentStart = now - windowMs;
  const baselineStart = now - 2 * windowMs;

  const byScope = new Map<string, MetricSample[]>();
  for (const s of samples) {
    const key = `${s.scopeKind}:${s.scopeId}`;
    const list = byScope.get(key);
    if (list) list.push(s);
    else byScope.set(key, [s]);
  }

  const alerts: RegressionAlert[] = [];
  const generatedAt = now;

  for (const [key, scopeSamples] of byScope) {
    const [scopeKind, ...rest] = key.split(':');
    const scopeId = rest.join(':');
    const baseline = statsFor(scopeSamples.filter((s) => s.ts >= baselineStart && s.ts < currentStart));
    const current = statsFor(scopeSamples.filter((s) => s.ts >= currentStart && s.ts <= now));
    if (baseline.samples < minSamples || current.samples < minSamples) continue;

    const consider = (
      metric: RegressionMetric,
      baselineVal: number | null,
      currentVal: number | null,
      opts2: { absoluteGuardPp?: number } = {},
    ): void => {
      if (baselineVal === null || currentVal === null || baselineVal <= 0) return;
      const changePct = ((currentVal - baselineVal) / baselineVal) * 100;
      if (changePct <= thresholdPct) return;
      if (opts2.absoluteGuardPp !== undefined && (currentVal - baselineVal) * 100 < opts2.absoluteGuardPp) return;
      alerts.push({
        id: `${scopeKind}:${scopeId}:${metric}`,
        scopeKind: scopeKind as 'workflow' | 'bot',
        scopeId,
        metric,
        metricLabel: METRIC_LABELS[metric],
        baseline: baselineVal,
        current: currentVal,
        changePct,
        changeUnit: 'percent',
        baselineSamples: baseline.samples,
        currentSamples: current.samples,
        windowStart: currentStart,
        windowEnd: now,
        generatedAt,
      });
    };

    consider('latency-p50', baseline.p50Latency, current.p50Latency);
    consider('error-rate', baseline.errorRate, current.errorRate, { absoluteGuardPp: errorAbsPp });
    consider('cost-per-run', baseline.meanCost, current.meanCost);
  }

  alerts.sort((a, b) => b.changePct - a.changePct);
  return alerts;
}

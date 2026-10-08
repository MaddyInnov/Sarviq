// SPDX-License-Identifier: Apache-2.0
// Cost model: converts metered usage into integer USD cents.
//
//   BILLING_INPUT_PER_1M_CENTS=30    → $0.00030 per 1k input tokens
//   BILLING_OUTPUT_PER_1M_CENTS=60   → $0.00060 per 1k output tokens
//   BILLING_WORKFLOW_RUN_CENTS=5     → $0.05 flat per workflow run
//   BILLING_SANDBOX_MINUTE_CENTS=2   → $0.02 per sandbox minute
//
// Defaults are illustrative list prices for the mock provider, not real
// provider costs. A real provider (Stripe) prices plans separately; this
// model prices usage so the ledger can quote invoices.

import type { UsageSummary } from './meter.js';

export interface PriceConfig {
  inputPer1MCents: number;
  outputPer1MCents: number;
  workflowRunCents: number;
  sandboxMinuteCents: number;
}

export function resolvePriceConfig(env: NodeJS.ProcessEnv = process.env): PriceConfig {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number (got ${raw})`);
    return v;
  };
  return {
    inputPer1MCents: num('BILLING_INPUT_PER_1M_CENTS', 30),
    outputPer1MCents: num('BILLING_OUTPUT_PER_1M_CENTS', 60),
    workflowRunCents: num('BILLING_WORKFLOW_RUN_CENTS', 5),
    sandboxMinuteCents: num('BILLING_SANDBOX_MINUTE_CENTS', 2),
  };
}

/** Total USD cents for a usage summary under the price config. */
export function costOfUsage(summary: UsageSummary, config: PriceConfig = resolvePriceConfig()): number {
  const input = Math.round((summary.promptTokens / 1_000_000) * config.inputPer1MCents);
  const output = Math.round((summary.completionTokens / 1_000_000) * config.outputPer1MCents);
  const workflows = summary.workflowRuns * config.workflowRunCents;
  const sandbox = Math.round(summary.sandboxMinutes * config.sandboxMinuteCents);
  return input + output + workflows + sandbox;
}

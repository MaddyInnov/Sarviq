// SPDX-License-Identifier: Apache-2.0
// Client-side mirrors of packages/agent-runtime/src/usage.ts (pure functions
// duplicated so the static web build has no workspace dependency).

/** Compact token count: 999 → "999", 1240 → "1.2k", 2_400_000 → "2.4M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
}

export interface ContextMeter {
  used: number;
  limit: number;
  pct: number;
  warn: boolean;
}

export const CONTEXT_WARN_PCT = 80;

/** Context-window consumption. Null when the model's context length is unknown. */
export function contextMeter(usedTokens: number, contextLength?: number): ContextMeter | null {
  if (contextLength === undefined || contextLength <= 0 || !Number.isFinite(usedTokens) || usedTokens < 0) {
    return null;
  }
  const pct = (usedTokens / contextLength) * 100;
  return { used: usedTokens, limit: contextLength, pct, warn: pct >= CONTEXT_WARN_PCT };
}

/**
 * Human countdown for a rate-limit resetAt ISO timestamp:
 * "resets in 42s", "resets in 3m 12s". Null when unknown.
 */
export function formatResetIn(resetAt: string | undefined, nowMs = Date.now()): string | null {
  if (!resetAt) return null;
  const target = new Date(resetAt).getTime();
  if (!Number.isFinite(target)) return null;
  const ms = target - nowMs;
  if (ms <= 0) return 'resetting…';
  const s = Math.round(ms / 1000);
  if (s < 60) return `resets in ${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `resets in ${m}m` : `resets in ${m}m ${r}s`;
}

// ---- Cost-in-dollars (client-side mirror of agent-runtime/src/pricing.ts) ---

export interface TokenUsageLike {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelPriceLike {
  inputPer1M?: number;
  outputPer1M?: number;
  estimated: boolean;
  free: boolean;
}

export interface UsageCost {
  input: number;
  output: number;
  total: number;
  estimated: boolean;
}

/**
 * Dollar cost of a token usage record against a /api/models price entry.
 * Unknown price (undefined) → $0 with estimated:true — an honest "unknown",
 * never presented as exact.
 */
export function costOfUsage(price: ModelPriceLike | undefined, usage: TokenUsageLike): UsageCost {
  if (!price || price.inputPer1M === undefined || price.outputPer1M === undefined) {
    return { input: 0, output: 0, total: 0, estimated: true };
  }
  const input = (usage.promptTokens / 1_000_000) * price.inputPer1M;
  const output = (usage.completionTokens / 1_000_000) * price.outputPer1M;
  return { input, output, total: input + output, estimated: price.estimated };
}

/** Compact USD: 0 → "$0", 0.00042 → "$0.00042", 7.5 → "$7.50". */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  if (n < 100) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${n.toFixed(2)}`;
}

/** Tooltip caveat shared by every cost surface: prices are estimates. */
export const COST_ESTIMATE_TOOLTIP =
  'Estimated cost from public list prices — actual billing may differ. Free-tier models cost $0.';

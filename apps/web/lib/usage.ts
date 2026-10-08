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

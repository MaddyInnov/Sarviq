// SPDX-License-Identifier: Apache-2.0
// Pure helpers for presenting token usage and context-window consumption.
// The web app mirrors these in apps/web/lib/usage.ts so both surfaces agree.

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
  /** Tokens consumed (per turn or per session). */
  used: number;
  /** Model context window in tokens. */
  limit: number;
  /** used / limit * 100. */
  pct: number;
  /** True once pct >= 80 — the UI should warn the user. */
  warn: boolean;
}

export const CONTEXT_WARN_PCT = 80;

/**
 * Context-window consumption for a turn or a session. Returns null when the
 * model's context length is unknown (no meter can be drawn honestly).
 */
export function contextMeter(usedTokens: number, contextLength?: number): ContextMeter | null {
  if (contextLength === undefined || contextLength <= 0 || !Number.isFinite(usedTokens) || usedTokens < 0) {
    return null;
  }
  const pct = (usedTokens / contextLength) * 100;
  return { used: usedTokens, limit: contextLength, pct, warn: pct >= CONTEXT_WARN_PCT };
}

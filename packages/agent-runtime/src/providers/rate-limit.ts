// SPDX-License-Identifier: Apache-2.0
// Rate-limit / quota snapshots captured from provider response headers.
// Drivers record the latest snapshot per provider id; the API exposes it via
// GET /api/providers so the UI can show "remaining" without extra calls.
// Providers that send no headers degrade to null (the UI renders "—").
//
// Header shapes:
// - Groq / OpenAI / OpenRouter (OpenAI-compatible):
//   x-ratelimit-limit-requests, x-ratelimit-remaining-requests,
//   x-ratelimit-reset-requests (seconds or durations like "6m0s"),
//   and the -tokens counterparts.
// - Anthropic:
//   anthropic-ratelimit-requests-limit/-remaining/-reset (reset is RFC 3339),
//   and the tokens- counterparts.

export interface RateLimitSnapshot {
  remainingRequests?: number;
  limitRequests?: number;
  remainingTokens?: number;
  limitTokens?: number;
  /** ISO 8601 timestamp when the current rate-limit window resets, when known. */
  resetAt?: string;
}

function numOrUndefined(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a reset value expressed as bare seconds ("42", "1.5") or a duration
 * ("500ms", "1s", "6m0s", "1h2m3s") into seconds. Returns undefined when the
 * value is absent or unparseable — callers then leave resetAt unset.
 */
export function parseResetSeconds(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const s = raw.trim();
  if (s.length === 0) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s); // bare seconds
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const v = parseFloat(m[1]!);
    switch (m[2]) {
      case 'h':
        total += v * 3600;
        break;
      case 'm':
        total += v * 60;
        break;
      case 's':
        total += v;
        break;
      case 'ms':
        total += v / 1000;
        break;
    }
  }
  if (!matched) return undefined;
  // Reject trailing garbage the pairs didn't consume ("1x", "abc").
  if (s.replace(/(\d+(?:\.\d+)?)(ms|s|m|h)/g, '').length > 0) return undefined;
  return total;
}

function isoOrUndefined(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function resetAtFromSeconds(seconds: number | undefined, nowMs = Date.now()): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return new Date(nowMs + seconds * 1000).toISOString();
}

type SnapKey = 'remainingRequests' | 'limitRequests' | 'remainingTokens' | 'limitTokens';

function assignNum(snap: RateLimitSnapshot, key: SnapKey, v: number | undefined): void {
  if (v !== undefined) snap[key] = v;
}

/** Parse Groq/OpenAI/OpenRouter-style x-ratelimit-* headers. */
export function parseOpenAIRateLimitHeaders(headers: Headers): RateLimitSnapshot | null {
  const snap: RateLimitSnapshot = {};
  assignNum(snap, 'limitRequests', numOrUndefined(headers.get('x-ratelimit-limit-requests')));
  assignNum(snap, 'remainingRequests', numOrUndefined(headers.get('x-ratelimit-remaining-requests')));
  assignNum(snap, 'limitTokens', numOrUndefined(headers.get('x-ratelimit-limit-tokens')));
  assignNum(snap, 'remainingTokens', numOrUndefined(headers.get('x-ratelimit-remaining-tokens')));
  const resetSec =
    parseResetSeconds(headers.get('x-ratelimit-reset-requests')) ??
    parseResetSeconds(headers.get('x-ratelimit-reset-tokens'));
  const resetAt = resetAtFromSeconds(resetSec);
  if (resetAt !== undefined) snap.resetAt = resetAt;
  return Object.keys(snap).length > 0 ? snap : null;
}

/** Parse Anthropic-style anthropic-ratelimit-* headers (resets are RFC 3339). */
export function parseAnthropicRateLimitHeaders(headers: Headers): RateLimitSnapshot | null {
  const snap: RateLimitSnapshot = {};
  assignNum(snap, 'limitRequests', numOrUndefined(headers.get('anthropic-ratelimit-requests-limit')));
  assignNum(
    snap,
    'remainingRequests',
    numOrUndefined(headers.get('anthropic-ratelimit-requests-remaining')),
  );
  assignNum(snap, 'limitTokens', numOrUndefined(headers.get('anthropic-ratelimit-tokens-limit')));
  assignNum(
    snap,
    'remainingTokens',
    numOrUndefined(headers.get('anthropic-ratelimit-tokens-remaining')),
  );
  const reset =
    isoOrUndefined(headers.get('anthropic-ratelimit-requests-reset')) ??
    isoOrUndefined(headers.get('anthropic-ratelimit-tokens-reset'));
  if (reset !== undefined) snap.resetAt = reset;
  return Object.keys(snap).length > 0 ? snap : null;
}

// ---- Per-provider latest-snapshot registry (process-local) -----------------

const snapshots = new Map<string, RateLimitSnapshot>();

/**
 * Merge a fresh snapshot into the provider's latest. Fields absent from the
 * new snapshot keep their prior values (providers don't send every header on
 * every response).
 */
export function recordRateLimit(providerId: string, snap: RateLimitSnapshot): void {
  snapshots.set(providerId, { ...(snapshots.get(providerId) ?? {}), ...snap });
}

export function getRateLimit(providerId: string): RateLimitSnapshot | null {
  return snapshots.get(providerId) ?? null;
}

/** Test hook: clear all recorded snapshots. */
export function resetRateLimits(): void {
  snapshots.clear();
}

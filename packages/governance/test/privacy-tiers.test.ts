// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  allowsCloudEgress,
  DEFAULT_TIER_BY_SOURCE,
  EgressGate,
  isPrivacyTier,
  normalizeTelemetryName,
  PrivacyTierDeniedError,
  resolveTier,
  sanitizeTelemetry,
  tierAtMost,
  tierRank,
} from '../src/privacy-tiers.js';

describe('privacy tiers', () => {
  it('ranks metadata < cloud-ok < local-only', () => {
    expect(tierRank('metadata')).toBeLessThan(tierRank('cloud-ok'));
    expect(tierRank('cloud-ok')).toBeLessThan(tierRank('local-only'));
    expect(tierAtMost('cloud-ok', 'cloud-ok')).toBe(true);
    expect(tierAtMost('local-only', 'cloud-ok')).toBe(false);
    expect(tierAtMost('metadata', 'cloud-ok')).toBe(true);
  });

  it('allows cloud egress for metadata and cloud-ok, never for local-only', () => {
    expect(allowsCloudEgress('metadata')).toBe(true);
    expect(allowsCloudEgress('cloud-ok')).toBe(true);
    expect(allowsCloudEgress('local-only')).toBe(false);
  });

  it('rejects unknown tier strings', () => {
    expect(isPrivacyTier('local-only')).toBe(true);
    expect(isPrivacyTier('secret')).toBe(false);
    expect(isPrivacyTier(undefined)).toBe(false);
    expect(() => resolveTier('memory', 'top-secret')).toThrow(/metadata\|cloud-ok\|local-only/);
  });

  it('resolves write-time defaults per source, overridable', () => {
    expect(DEFAULT_TIER_BY_SOURCE['vault']).toBe('local-only');
    expect(DEFAULT_TIER_BY_SOURCE['memory']).toBe('cloud-ok');
    expect(resolveTier('vault')).toBe('local-only');
    expect(resolveTier('memory')).toBe('cloud-ok');
    expect(resolveTier('vault', 'cloud-ok')).toBe('cloud-ok');
    expect(resolveTier('unknown-source')).toBe('cloud-ok');
  });
});

describe('EgressGate', () => {
  it('allows payloads with no local-only items', () => {
    const gate = new EgressGate();
    const res = gate.check([
      { id: 'a', tier: 'metadata' },
      { id: 'b', tier: 'cloud-ok' },
    ]);
    expect(res.allowed).toBe(true);
    expect(res.blocked).toEqual([]);
    expect(() => gate.assertEgress([{ id: 'a', tier: 'cloud-ok' }])).not.toThrow();
  });

  it('denies local-only with an audit entry and never leaks contents', () => {
    const audited: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const gate = new EgressGate((action, detail) => audited.push({ action, detail }));
    const items = [
      { id: 'note-1', tier: 'cloud-ok' as const },
      { id: 'secret-9', tier: 'local-only' as const },
    ];
    const res = gate.check(items);
    expect(res.allowed).toBe(false);
    expect(res.blocked.map((b) => b.id)).toEqual(['secret-9']);

    let err: unknown;
    try {
      gate.assertEgress(items, { where: 'provider.chat' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PrivacyTierDeniedError);
    expect((err as Error).message).toMatch(/local-only/);
    // One audit entry, ids/tiers only — no contents.
    expect(audited.length).toBe(1);
    expect(audited[0].action).toBe('privacy.egress_denied');
    const detailJson = JSON.stringify(audited[0].detail);
    expect(detailJson).toContain('secret-9');
    expect(detailJson).toContain('local-only');
    expect(detailJson).toContain('provider.chat');
  });

  it('audits even when the audit sink throws (denial still stands)', () => {
    const gate = new EgressGate(() => {
      throw new Error('sink down');
    });
    expect(() => gate.assertEgress([{ tier: 'local-only' }])).toThrow(PrivacyTierDeniedError);
  });

  it('filterForCloud drops local-only items', () => {
    const gate = new EgressGate();
    const kept = gate.filterForCloud([
      { id: 'a', tier: 'metadata' },
      { id: 'b', tier: 'local-only' },
      { id: 'c', tier: 'cloud-ok' },
    ]);
    expect(kept.map((k) => k.id)).toEqual(['a', 'c']);
  });
});

describe('telemetry ingestion guard', () => {
  describe('normalizeTelemetryName', () => {
    it('templates UUIDs, numeric path segments, and long hex ids', () => {
      expect(normalizeTelemetryName('/api/bots/550e8400-e29b-41d4-a716-446655440000/chat')).toBe(
        '/api/bots/:id/chat',
      );
      expect(normalizeTelemetryName('/api/bots/12345/chat')).toBe('/api/bots/:id/chat');
      expect(normalizeTelemetryName('/api/sessions/deadbeefcafebabe1234/messages')).toBe(
        '/api/sessions/:id/messages',
      );
    });

    it('strips query strings entirely (query values never persist)', () => {
      expect(normalizeTelemetryName('/api/bots/123/chat?session=abc&user=bob')).toBe('/api/bots/:id/chat');
    });

    it('leaves plain template names untouched', () => {
      expect(normalizeTelemetryName('/api/health')).toBe('/api/health');
      expect(normalizeTelemetryName('support-bot')).toBe('support-bot');
    });
  });

  describe('sanitizeTelemetry', () => {
    it('accepts clean payloads and normalizes route/screen/botName fields', () => {
      const res = sanitizeTelemetry({
        kind: 'bot-turn',
        botId: 'support-bot',
        botName: 'Support Bot 550e8400-e29b-41d4-a716-446655440000',
        route: '/api/bots/12345/chat?session=abc',
        screen: 'BotDetailScreen',
        durationMs: 120,
      });
      expect(res.accepted).toBe(true);
      expect(res.sanitized).toMatchObject({
        kind: 'bot-turn',
        botId: 'support-bot', // ids stay exact (needed for joins)
        botName: 'Support Bot :id',
        route: '/api/bots/:id/chat',
        screen: 'BotDetailScreen',
        durationMs: 120,
      });
    });

    it('REFUSES payloads carrying bodies — never stored, warning logged', () => {
      const warnings: Array<{ message: string; detail: Record<string, unknown> }> = [];
      const payload = { kind: 'bot-turn', request: { body: { message: 'my secret text' } } };
      const res = sanitizeTelemetry(payload, (message, detail) => warnings.push({ message, detail }));
      expect(res.accepted).toBe(false);
      expect(res.sanitized).toBeUndefined();
      expect(res.droppedFields).toEqual(['request.body']);
      expect(res.reason).toMatch(/body/);
      // A warning was logged, carrying key paths only — never values.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toMatch(/refused/);
      const warned = JSON.stringify(warnings[0]!.detail);
      expect(warned).not.toContain('my secret text');
    });

    it('REFUSES headers, cookies, and query values — including nested and case variants', () => {
      for (const payload of [
        { headers: { authorization: 'Bearer x' } },
        { Headers: { 'x-a': 'b' } },
        { cookies: { session: 'abc' } },
        { request: { cookie: 'a=b' } },
        { query: { q: 'search terms' } },
        { url: '/x', querystring: 'a=b' },
        { auth: { token: 'sekret' } },
      ]) {
        const res = sanitizeTelemetry(payload, () => {});
        expect(res.accepted).toBe(false);
        expect(res.sanitized).toBeUndefined();
        expect(res.droppedFields!.length).toBeGreaterThan(0);
      }
    });

    it('refuses non-object payloads', () => {
      for (const bad of [null, undefined, 42, 'x', [1, 2]]) {
        const res = sanitizeTelemetry(bad, () => {});
        expect(res.accepted).toBe(false);
        expect(res.sanitized).toBeUndefined();
      }
    });

    it('survives a throwing warn sink (refusal still stands)', () => {
      const res = sanitizeTelemetry({ body: 'x' }, () => {
        throw new Error('sink down');
      });
      expect(res.accepted).toBe(false);
    });

    it('handles cyclic payloads without hanging', () => {
      const payload: Record<string, unknown> = { kind: 'bot-turn' };
      payload['self'] = payload;
      const res = sanitizeTelemetry(payload, () => {});
      expect(res.accepted).toBe(true);
    });
  });
});

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  allowsCloudEgress,
  DEFAULT_TIER_BY_SOURCE,
  EgressGate,
  isPrivacyTier,
  PrivacyTierDeniedError,
  resolveTier,
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

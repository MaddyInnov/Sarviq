// SPDX-License-Identifier: Apache-2.0
// Vault privacy tiers: secrets are tagged at write time (default
// local-only), tiers survive roundtrips, and pre-tier secrets fail closed.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EgressGate } from '@mvp/governance';
import { SecureVault } from '../src/index.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'vault-tier-'));
}

describe('SecureVault privacy tiers', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it('defaults new secrets to local-only', () => {
    const vault = new SecureVault(dir);
    const meta = vault.create('api-key', 'sekret');
    expect(meta.tier).toBe('local-only');
    expect(vault.get('api-key')?.tier).toBe('local-only');
    expect(vault.list()[0].tier).toBe('local-only');
  });

  it('accepts an explicit tier override at create and update', () => {
    const vault = new SecureVault(dir);
    const meta = vault.create('webhook-url', 'https://x', undefined, { tier: 'cloud-ok' });
    expect(meta.tier).toBe('cloud-ok');

    const updated = vault.update('webhook-url', undefined, undefined, { tier: 'metadata' });
    expect(updated.tier).toBe('metadata');
    expect(vault.get('webhook-url')?.tier).toBe('metadata');

    // Update without a tier keeps the existing one.
    const kept = vault.update('webhook-url', 'https://y');
    expect(kept.tier).toBe('metadata');
  });

  it('rejects invalid tiers', () => {
    const vault = new SecureVault(dir);
    expect(() => vault.create('k', 'v', undefined, { tier: 'secret' as never })).toThrow(
      /metadata\|cloud-ok\|local-only/,
    );
  });

  it('a vault secret never passes the egress gate', () => {
    const vault = new SecureVault(dir);
    vault.create('prod-key', 'sekret');
    const gate = new EgressGate();
    const secret = vault.get('prod-key')!;
    // The gate denies any local-only item in an egress payload.
    expect(() => gate.assertEgress([{ id: secret.name, tier: secret.tier }])).toThrow(
      /local-only/,
    );
    // …while a cloud-ok secret is allowed through.
    vault.create('public-feed', 'https://x', undefined, { tier: 'cloud-ok' });
    const ok = vault.get('public-feed')!;
    expect(() => gate.assertEgress([{ id: ok.name, tier: ok.tier }])).not.toThrow();
  });
});

// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCreatorShare, RevenueLedger } from '../src/revenue.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'mkt-rev-test-')), 'marketplace.db');
}

describe('resolveCreatorShare', () => {
  it('defaults to 0.70', () => {
    expect(resolveCreatorShare({})).toBe(0.7);
  });

  it('reads MARKETPLACE_CREATOR_SHARE', () => {
    expect(resolveCreatorShare({ MARKETPLACE_CREATOR_SHARE: '0.8' })).toBe(0.8);
  });

  it('rejects out-of-range values', () => {
    expect(() => resolveCreatorShare({ MARKETPLACE_CREATOR_SHARE: '1.5' })).toThrow();
    expect(() => resolveCreatorShare({ MARKETPLACE_CREATOR_SHARE: '-0.1' })).toThrow();
    expect(() => resolveCreatorShare({ MARKETPLACE_CREATOR_SHARE: 'nope' })).toThrow();
  });
});

describe('RevenueLedger', () => {
  it('tracks installs and usage per creator', () => {
    const ledger = new RevenueLedger(tmpDb());
    ledger.recordInstall('dataforge', 'sql-tuner', 'bot');
    ledger.recordInstall('dataforge', 'sql-tuner', 'bot');
    ledger.recordUsage('dataforge', 'sql-tuner', 1500);
    ledger.recordUsage('dataforge', 'sql-tuner', 500);
    const s = ledger.creatorSummary('dataforge');
    expect(s.installs).toBe(2);
    expect(s.usageTokens).toBe(2000);
    expect(s.balanceCents).toBe(0);
    ledger.close();
  });

  it('splits a sale between creator and platform at the configured share', () => {
    const ledger = new RevenueLedger(tmpDb(), 0.7);
    const { creatorCents, platformCents } = ledger.creditSale({
      creator: 'dataforge',
      entryId: 'sql-tuner',
      amountCents: 1000,
    });
    expect(creatorCents).toBe(700);
    expect(platformCents).toBe(300);
    expect(ledger.creatorSummary('dataforge').balanceCents).toBe(700);
    expect(ledger.platformEarningsCents()).toBe(300);
    ledger.close();
  });

  it('records payouts as negative ledger entries', () => {
    const ledger = new RevenueLedger(tmpDb(), 0.7);
    ledger.creditSale({ creator: 'dataforge', entryId: 'sql-tuner', amountCents: 1000 });
    const payout = ledger.recordPayout('dataforge', 500, 'first payout');
    expect(payout.amountCents).toBe(-500);
    expect(payout.kind).toBe('payout');
    expect(ledger.creatorSummary('dataforge').balanceCents).toBe(200);
    ledger.close();
  });

  it('lists creators and ledger entries', () => {
    const ledger = new RevenueLedger(tmpDb());
    ledger.recordInstall('alice', 'e1', 'bot');
    ledger.recordUsage('bob', 'e2', 10);
    expect(ledger.listCreators().sort()).toEqual(['alice', 'bob']);
    ledger.creditSale({ creator: 'alice', entryId: 'e1', amountCents: 200 });
    const entries = ledger.ledgerFor('alice');
    expect(entries.length).toBe(1);
    expect(entries[0].amountCents).toBe(140);
    ledger.close();
  });

  it('rejects invalid amounts', () => {
    const ledger = new RevenueLedger(tmpDb());
    expect(() => ledger.creditSale({ creator: 'a', entryId: 'e', amountCents: -1 })).toThrow();
    expect(() => ledger.creditSale({ creator: 'a', entryId: 'e', amountCents: 10.5 })).toThrow();
    expect(() => ledger.recordPayout('a', 0)).toThrow();
    expect(() => ledger.recordUsage('a', 'e', -3)).toThrow();
    ledger.close();
  });
});

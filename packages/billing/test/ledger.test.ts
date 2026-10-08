// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BillingLedger } from '../src/ledger.js';
import { costOfUsage, resolvePriceConfig } from '../src/pricing.js';
import { MockBillingProvider } from '../src/provider.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'bill-ledger-test-')), 'billing.db');
}

describe('BillingLedger', () => {
  it('persists provider invoices and mirrors status changes', async () => {
    const provider = new MockBillingProvider();
    const ledger = new BillingLedger(tmpDb());
    const cus = await provider.createCustomer({ email: 'founder@example.com' });
    const inv = await provider.createInvoice({
      customerId: cus.id,
      lines: [{ description: 'tokens', amountCents: 120 }],
    });
    const recorded = ledger.recordInvoice(inv, inv.id);
    expect(recorded.providerInvoiceId).toBe(inv.id);
    expect(recorded.status).toBe('draft');
    expect(recorded.lines.length).toBe(1);

    await provider.finalizeInvoice(inv.id);
    const open = ledger.updateStatus(inv.id, 'open', { finalizedAt: Date.now() });
    expect(open?.status).toBe('open');

    await provider.markInvoicePaid(inv.id);
    const paid = ledger.updateStatus(inv.id, 'paid', { paidAt: Date.now() });
    expect(paid?.status).toBe('paid');
    expect(ledger.customerPaidCents(cus.id)).toBe(120);
    ledger.close();
  });

  it('lists invoices per customer', async () => {
    const provider = new MockBillingProvider();
    const ledger = new BillingLedger(tmpDb());
    const a = await provider.createCustomer({ email: 'a@b.c' });
    const b = await provider.createCustomer({ email: 'd@e.f' });
    for (let i = 0; i < 3; i++) {
      const inv = await provider.createInvoice({
        customerId: a.id,
        lines: [{ description: `line ${i}`, amountCents: 10 }],
      });
      ledger.recordInvoice(inv);
    }
    const invB = await provider.createInvoice({
      customerId: b.id,
      lines: [{ description: 'x', amountCents: 5 }],
    });
    ledger.recordInvoice(invB);
    expect(ledger.listInvoices({ customerId: a.id }).length).toBe(3);
    expect(ledger.listInvoices().length).toBe(4);
    ledger.close();
  });

  it('returns undefined for unknown invoices', () => {
    const ledger = new BillingLedger(tmpDb());
    expect(ledger.getInvoice('nope')).toBeUndefined();
    expect(ledger.updateStatus('nope', 'paid')).toBeUndefined();
    ledger.close();
  });
});

describe('pricing', () => {
  it('resolves defaults and env overrides', () => {
    const d = resolvePriceConfig({});
    expect(d.inputPer1MCents).toBe(30);
    const o = resolvePriceConfig({ BILLING_INPUT_PER_1M_CENTS: '100' });
    expect(o.inputPer1MCents).toBe(100);
    expect(() => resolvePriceConfig({ BILLING_INPUT_PER_1M_CENTS: '-1' })).toThrow();
  });

  it('costs a usage summary in integer cents', () => {
    const cost = costOfUsage(
      {
        sessions: 2,
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
        workflowRuns: 3,
        sandboxMinutes: 10,
      },
      { inputPer1MCents: 100, outputPer1MCents: 200, workflowRunCents: 5, sandboxMinuteCents: 2 },
    );
    // 100 + 100 + 15 + 20 = 235
    expect(cost).toBe(235);
    expect(Number.isInteger(cost)).toBe(true);
  });
});

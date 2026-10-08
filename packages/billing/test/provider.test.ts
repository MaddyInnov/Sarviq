// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { MockBillingProvider } from '../src/provider.js';

describe('MockBillingProvider', () => {
  it('creates and fetches customers', async () => {
    const p = new MockBillingProvider();
    const cus = await p.createCustomer({ email: 'founder@example.com', name: 'Founder' });
    expect(cus.id.startsWith('cus_')).toBe(true);
    expect((await p.getCustomer(cus.id))?.email).toBe('founder@example.com');
    await expect(p.createCustomer({ email: 'not-an-email' })).rejects.toThrow();
  });

  it('runs the invoice lifecycle: draft → open → paid', async () => {
    const p = new MockBillingProvider();
    const cus = await p.createCustomer({ email: 'founder@example.com' });
    const inv = await p.createInvoice({
      customerId: cus.id,
      lines: [
        { description: 'token usage', amountCents: 120 },
        { description: 'workflow runs', amountCents: 30 },
      ],
    });
    expect(inv.id.startsWith('in_')).toBe(true);
    expect(inv.status).toBe('draft');
    expect(inv.totalCents).toBe(150);

    const open = await p.finalizeInvoice(inv.id);
    expect(open.status).toBe('open');
    const paid = await p.markInvoicePaid(inv.id);
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).not.toBeNull();
    await expect(p.markInvoicePaid(inv.id)).rejects.toThrow();
  });

  it('voids unpaid invoices but not paid ones', async () => {
    const p = new MockBillingProvider();
    const cus = await p.createCustomer({ email: 'founder@example.com' });
    const inv = await p.createInvoice({ customerId: cus.id, lines: [{ description: 'x', amountCents: 10 }] });
    await p.finalizeInvoice(inv.id);
    expect((await p.voidInvoice(inv.id)).status).toBe('void');

    const inv2 = await p.createInvoice({ customerId: cus.id, lines: [{ description: 'x', amountCents: 10 }] });
    await p.finalizeInvoice(inv2.id);
    await p.markInvoicePaid(inv2.id);
    await expect(p.voidInvoice(inv2.id)).rejects.toThrow();
  });

  it('rejects invoices for unknown customers or empty lines', async () => {
    const p = new MockBillingProvider();
    await expect(
      p.createInvoice({ customerId: 'cus_nope', lines: [{ description: 'x', amountCents: 1 }] }),
    ).rejects.toThrow(/unknown customer/);
    const cus = await p.createCustomer({ email: 'a@b.c' });
    await expect(p.createInvoice({ customerId: cus.id, lines: [] })).rejects.toThrow();
  });

  it('runs the payment intent lifecycle', async () => {
    const p = new MockBillingProvider();
    const cus = await p.createCustomer({ email: 'founder@example.com' });
    const pi = await p.createPaymentIntent({ customerId: cus.id, amountCents: 500 });
    expect(pi.id.startsWith('pi_')).toBe(true);
    expect(pi.status).toBe('requires_confirmation');
    expect((await p.confirmPaymentIntent(pi.id)).status).toBe('succeeded');
    await expect(p.cancelPaymentIntent(pi.id)).rejects.toThrow(/already succeeded/);

    const pi2 = await p.createPaymentIntent({ customerId: cus.id, amountCents: 100 });
    expect((await p.cancelPaymentIntent(pi2.id)).status).toBe('canceled');
    await expect(p.confirmPaymentIntent(pi2.id)).rejects.toThrow();
  });

  it('is fully in-memory: fresh instances start empty', async () => {
    const p = new MockBillingProvider();
    expect(await p.getCustomer('cus_whatever')).toBeUndefined();
    expect(await p.getInvoice('in_whatever')).toBeUndefined();
    expect(await p.getPaymentIntent('pi_whatever')).toBeUndefined();
  });
});

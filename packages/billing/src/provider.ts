// SPDX-License-Identifier: Apache-2.0
// Billing provider abstraction. The MVP ships a MOCK implementation only
// (MockBillingProvider) — Stripe-shaped objects (customers, invoices,
// payment intents) with zero network traffic. A real Stripe provider can
// implement BillingProvider later; it would read STRIPE_SECRET_KEY from env
// (never hardcoded).

export interface BillingCustomer {
  id: string;
  email: string;
  name?: string;
  createdAt: number;
  metadata?: Record<string, string>;
}

export interface InvoiceLine {
  description: string;
  /** Integer USD cents. */
  amountCents: number;
  quantity?: number;
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'canceled';

export interface BillingInvoice {
  id: string;
  customerId: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  /** Integer USD cents. */
  totalCents: number;
  createdAt: number;
  finalizedAt: number | null;
  paidAt: number | null;
}

export interface PaymentIntent {
  id: string;
  customerId: string;
  /** Integer USD cents. */
  amountCents: number;
  currency: string;
  status: PaymentIntentStatus;
  createdAt: number;
}

export interface BillingProvider {
  readonly name: string;
  createCustomer(input: { email: string; name?: string; metadata?: Record<string, string> }): Promise<BillingCustomer>;
  getCustomer(id: string): Promise<BillingCustomer | undefined>;
  createInvoice(input: { customerId: string; lines: InvoiceLine[] }): Promise<BillingInvoice>;
  getInvoice(id: string): Promise<BillingInvoice | undefined>;
  finalizeInvoice(id: string): Promise<BillingInvoice>;
  /** Mark an open invoice paid (mock settlement; real provider charges the card). */
  markInvoicePaid(id: string): Promise<BillingInvoice>;
  voidInvoice(id: string): Promise<BillingInvoice>;
  createPaymentIntent(input: {
    customerId: string;
    amountCents: number;
    currency?: string;
  }): Promise<PaymentIntent>;
  getPaymentIntent(id: string): Promise<PaymentIntent | undefined>;
  /** Mock-confirm a payment intent: requires_confirmation → succeeded. */
  confirmPaymentIntent(id: string): Promise<PaymentIntent>;
  cancelPaymentIntent(id: string): Promise<PaymentIntent>;
}

function mockId(prefix: string): string {
  return `${prefix}_mock_${Math.random().toString(36).slice(2, 10)}`;
}

function requireEmail(email: unknown): string {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('customer email must be a valid email address');
  }
  return email;
}

function requirePositiveCents(v: unknown, name: string): number {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${name} must be a positive integer (cents)`);
  return v as number;
}

/**
 * In-memory mock billing provider. Stripe-shaped ids and statuses, no
 * network, no real money. Suitable for tests and local demos only.
 */
export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock';

  private readonly customers = new Map<string, BillingCustomer>();
  private readonly invoices = new Map<string, BillingInvoice>();
  private readonly paymentIntents = new Map<string, PaymentIntent>();

  async createCustomer(input: {
    email: string;
    name?: string;
    metadata?: Record<string, string>;
  }): Promise<BillingCustomer> {
    const customer: BillingCustomer = {
      id: mockId('cus'),
      email: requireEmail(input.email),
      name: input.name,
      createdAt: Date.now(),
      metadata: input.metadata,
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  async getCustomer(id: string): Promise<BillingCustomer | undefined> {
    return this.customers.get(id);
  }

  async createInvoice(input: { customerId: string; lines: InvoiceLine[] }): Promise<BillingInvoice> {
    if (!this.customers.has(input.customerId)) throw new Error(`unknown customer: ${input.customerId}`);
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new Error('invoice needs at least one line item');
    }
    for (const line of input.lines) {
      if (typeof line.description !== 'string' || line.description.length === 0) {
        throw new Error('invoice line needs a description');
      }
      requirePositiveCents(line.amountCents, 'line amountCents');
    }
    const totalCents = input.lines.reduce((sum, l) => sum + l.amountCents, 0);
    const invoice: BillingInvoice = {
      id: mockId('in'),
      customerId: input.customerId,
      status: 'draft',
      lines: input.lines.map((l) => ({ ...l })),
      totalCents,
      createdAt: Date.now(),
      finalizedAt: null,
      paidAt: null,
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  async getInvoice(id: string): Promise<BillingInvoice | undefined> {
    return this.invoices.get(id);
  }

  async finalizeInvoice(id: string): Promise<BillingInvoice> {
    const inv = this.mustGetInvoice(id);
    if (inv.status !== 'draft') throw new Error(`invoice ${id} is not a draft (status: ${inv.status})`);
    inv.status = 'open';
    inv.finalizedAt = Date.now();
    return inv;
  }

  async markInvoicePaid(id: string): Promise<BillingInvoice> {
    const inv = this.mustGetInvoice(id);
    if (inv.status !== 'open') throw new Error(`invoice ${id} is not open (status: ${inv.status})`);
    inv.status = 'paid';
    inv.paidAt = Date.now();
    return inv;
  }

  async voidInvoice(id: string): Promise<BillingInvoice> {
    const inv = this.mustGetInvoice(id);
    if (inv.status === 'paid') throw new Error(`invoice ${id} is already paid and cannot be voided`);
    inv.status = 'void';
    return inv;
  }

  async createPaymentIntent(input: {
    customerId: string;
    amountCents: number;
    currency?: string;
  }): Promise<PaymentIntent> {
    if (!this.customers.has(input.customerId)) throw new Error(`unknown customer: ${input.customerId}`);
    const pi: PaymentIntent = {
      id: mockId('pi'),
      customerId: input.customerId,
      amountCents: requirePositiveCents(input.amountCents, 'amountCents'),
      currency: input.currency ?? 'usd',
      status: 'requires_confirmation',
      createdAt: Date.now(),
    };
    this.paymentIntents.set(pi.id, pi);
    return pi;
  }

  async getPaymentIntent(id: string): Promise<PaymentIntent | undefined> {
    return this.paymentIntents.get(id);
  }

  async confirmPaymentIntent(id: string): Promise<PaymentIntent> {
    const pi = this.paymentIntents.get(id);
    if (!pi) throw new Error(`unknown payment intent: ${id}`);
    if (pi.status !== 'requires_confirmation') {
      throw new Error(`payment intent ${id} cannot be confirmed from status ${pi.status}`);
    }
    pi.status = 'succeeded';
    return pi;
  }

  async cancelPaymentIntent(id: string): Promise<PaymentIntent> {
    const pi = this.paymentIntents.get(id);
    if (!pi) throw new Error(`unknown payment intent: ${id}`);
    if (pi.status === 'succeeded') throw new Error(`payment intent ${id} already succeeded`);
    pi.status = 'canceled';
    return pi;
  }

  private mustGetInvoice(id: string): BillingInvoice {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error(`unknown invoice: ${id}`);
    return inv;
  }
}

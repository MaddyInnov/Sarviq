// SPDX-License-Identifier: Apache-2.0
// Wallet provider abstraction + mock implementation (Phase 4, Workstream C).
//
// The MVP ships with a MOCK wallet only: payment methods are stored with
// only the last 4 PAN digits, brand, and expiry, and any charge attempt is
// refused. A real provider (Stripe, Razorpay, …) implements the same
// `WalletProvider` interface in a later phase — the API routes must not
// change shape when the founder swaps the provider.
//
// Zero paid usage: MockWalletProvider never touches a network.

import { join } from 'node:path';
import { readEncryptedJson, writeEncryptedJson } from './crypto.js';

export interface PaymentMethodInput {
  /** Full PAN — accepted only in memory at add-time; only last4 is persisted. */
  cardNumber: string;
  expMonth: number;
  expYear: number;
  holderName?: string;
}

export interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  holderName?: string;
  createdAt: number;
}

export interface WalletProvider {
  /** Registry id, e.g. 'mock'. */
  readonly id: string;
  /** False for the mock: charging is refused, never attempted. */
  readonly chargesEnabled: boolean;
  addPaymentMethod(input: PaymentMethodInput): PaymentMethod;
  listPaymentMethods(): PaymentMethod[];
  removePaymentMethod(id: string): boolean;
}

const WALLET_ERROR = '__wallet_error__';

function walletError(message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = WALLET_ERROR;
  return err;
}

export function isWalletError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === WALLET_ERROR;
}

/** Luhn checksum — the mock still rejects obviously-invalid card numbers. */
function luhnOk(pan: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let d = pan.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function detectBrand(pan: string): string {
  if (/^4/.test(pan)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(pan)) return 'mastercard';
  if (/^3[47]/.test(pan)) return 'amex';
  if (/^6/.test(pan)) return 'discover';
  if (/^35/.test(pan)) return 'jcb';
  return 'unknown';
}

interface WalletPayload {
  version: 1;
  methods: PaymentMethod[];
}

/**
 * Mock wallet provider for the MVP. Persists payment-method records
 * (last4 only, never the full PAN) in the same encrypted envelope format as
 * the vault. Charge attempts are refused — there is no real money path.
 */
export class MockWalletProvider implements WalletProvider {
  readonly id = 'mock';
  readonly chargesEnabled = false;

  private readonly filePath: string;
  private readonly keyPath: string;

  constructor(dataDir: string, namespace = 'default') {
    const clean = namespace.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'default';
    const suffix = clean === 'default' ? '' : `.${clean}`;
    this.filePath = join(dataDir, `wallet${suffix}.json`);
    this.keyPath = join(dataDir, '.vault-key');
  }

  path(): string {
    return this.filePath;
  }

  private load(): WalletPayload {
    const payload = readEncryptedJson<WalletPayload>(
      this.filePath,
      this.keyPath,
      { version: 1, methods: [] },
    );
    if (!payload || payload.version !== 1 || !Array.isArray(payload.methods)) {
      throw walletError(`wallet store at ${this.filePath} is corrupt — refusing to read`);
    }
    return payload;
  }

  private save(payload: WalletPayload): void {
    writeEncryptedJson(this.filePath, this.keyPath, payload);
  }

  addPaymentMethod(input: PaymentMethodInput): PaymentMethod {
    const pan = String(input.cardNumber ?? '').replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(pan) || !luhnOk(pan)) {
      throw walletError('card number is invalid');
    }
    const expMonth = Number(input.expMonth);
    const expYear = Number(input.expYear);
    if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) {
      throw walletError('expiry month must be 1-12');
    }
    const thisYear = new Date().getFullYear();
    if (!Number.isInteger(expYear) || expYear < thisYear || expYear > thisYear + 30) {
      throw walletError('expiry year is invalid');
    }
    const holderName =
      typeof input.holderName === 'string' && input.holderName.trim()
        ? input.holderName.trim().slice(0, 80)
        : undefined;
    const method: PaymentMethod = {
      id: `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      brand: detectBrand(pan),
      last4: pan.slice(-4),
      expMonth,
      expYear,
      ...(holderName ? { holderName } : {}),
      createdAt: Date.now(),
    };
    const payload = this.load();
    this.save({ ...payload, methods: [...payload.methods, method] });
    return method;
  }

  listPaymentMethods(): PaymentMethod[] {
    return this.load().methods.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  removePaymentMethod(id: string): boolean {
    const payload = this.load();
    const methods = payload.methods.filter((m) => m.id !== id);
    if (methods.length === payload.methods.length) return false;
    this.save({ ...payload, methods });
    return true;
  }

  /**
   * The mock never charges. Present so call sites that attempt a charge get
   * a loud, typed refusal instead of silently doing nothing.
   */
  charge(_input: { methodId: string; amountMinor: number; currency: string }): never {
    throw walletError(
      'MockWalletProvider never processes real charges — connect a real wallet provider to charge.',
    );
  }
}

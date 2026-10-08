// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { ShoppingStore, searchProducts, getProduct, MOCK_CATALOG } from './index.js';

describe('product search (mock catalog)', () => {
  it('searches name and description case-insensitively', () => {
    expect(searchProducts('lamp')).toHaveLength(1);
    expect(searchProducts('KEYBOARD')).toHaveLength(1);
    expect(searchProducts('')).toHaveLength(MOCK_CATALOG.length);
    expect(searchProducts('zzz-no-match')).toHaveLength(0);
  });

  it('getProduct throws for unknown ids', () => {
    expect(() => getProduct('prod-999')).toThrow(NotFoundError);
  });
});

describe('approval-gated purchase flow', () => {
  let db: ModuleDb;
  let store: ShoppingStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new ShoppingStore(db);
  });

  function filledCart() {
    const cart = store.createCart();
    return store.addItem(cart.id, 'prod-001', 2);
  }

  it('cart math is correct', () => {
    const cart = filledCart();
    expect(cart.totalCents).toBe(4999 * 2);
    expect(cart.items[0].lineTotalCents).toBe(4999 * 2);
  });

  it('addItem validates product and qty', () => {
    const cart = store.createCart();
    expect(() => store.addItem(cart.id, 'prod-999', 1)).toThrow(NotFoundError);
    expect(() => store.addItem(cart.id, 'prod-001', 0)).toThrow(ValidationError);
  });

  it('checkout creates a pending_approval order — never auto-completes', () => {
    const cart = filledCart();
    const order = store.checkout(cart.id);
    expect(order.status).toBe('pending_approval');
    expect(order.approvalCode).toMatch(/^MOCK-/);
    expect(order.totalCents).toBe(cart.totalCents);
  });

  it('checkout refuses empty carts', () => {
    const cart = store.createCart();
    expect(() => store.checkout(cart.id)).toThrow(ValidationError);
  });

  it('approveOrder requires the exact code', () => {
    const order = store.checkout(filledCart().id);
    expect(() => store.approveOrder(order.id, 'WRONG')).toThrow(ValidationError);
    expect(store.getOrder(order.id).status).toBe('pending_approval');
    const done = store.approveOrder(order.id, order.approvalCode);
    expect(done.status).toBe('ordered');
    expect(() => store.approveOrder(order.id, order.approvalCode)).toThrow(ValidationError);
  });

  it('cancelOrder works before ordering, not after', () => {
    const order = store.checkout(filledCart().id);
    expect(store.cancelOrder(order.id).status).toBe('cancelled');
    const order2 = store.checkout(filledCart().id);
    store.approveOrder(order2.id, order2.approvalCode);
    expect(() => store.cancelOrder(order2.id)).toThrow(ValidationError);
  });

  it('unknown cart/order ids throw NotFoundError', () => {
    expect(() => store.getCart('nope')).toThrow(NotFoundError);
    expect(() => store.getOrder('nope')).toThrow(NotFoundError);
  });
});

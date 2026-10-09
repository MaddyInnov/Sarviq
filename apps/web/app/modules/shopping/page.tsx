// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtMoney, PageHeader, ErrorBox, EmptyState, useModuleData } from '../lib';

interface Product {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  imageUrl: string;
}

interface CartLine {
  productId: string;
  qty: number;
  product: Product;
  lineTotalCents: number;
}

interface Cart {
  id: string;
  items: CartLine[];
  totalCents: number;
  currency: string;
}

interface Order {
  id: string;
  items: CartLine[];
  totalCents: number;
  currency: string;
  status: 'pending_approval' | 'ordered' | 'cancelled';
  approvalCode: string;
  createdAt: number;
}

export default function ShoppingPage() {
  const [query, setQuery] = useState('');
  const loadProducts = useCallback(
    () => api(`${MODULES_BASE}/shopping/products?q=${encodeURIComponent(query)}`) as Promise<Product[]>,
    [query],
  );
  const { data: products, error, refresh } = useModuleData(loadProducts);
  const [cart, setCart] = useState<Cart | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [approvalCode, setApprovalCode] = useState('');
  const [orderId, setOrderId] = useState('');

  const ensureCart = async (): Promise<Cart> => {
    if (cart) return cart;
    const c = (await api(`${MODULES_BASE}/shopping/carts`, { method: 'POST' })) as Cart;
    setCart(c);
    return c;
  };

  const addItem = async (productId: string) => {
    const c = await ensureCart();
    const updated = (await api(`${MODULES_BASE}/shopping/carts/${c.id}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, qty: 1 }),
    })) as Cart;
    setCart(updated);
  };

  const checkout = async () => {
    if (!cart) return;
    const o = (await api(`${MODULES_BASE}/shopping/carts/${cart.id}/checkout`, { method: 'POST' })) as Order;
    setOrder(o);
    setOrderId(o.id);
    setCart(null);
  };

  const approveOrder = async () => {
    if (!order) return;
    const o = (await api(`${MODULES_BASE}/shopping/orders/${order.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: approvalCode }),
    })) as Order;
    setOrder(o);
    setApprovalCode('');
  };

  const cancelOrder = async () => {
    if (!order) return;
    const o = (await api(`${MODULES_BASE}/shopping/orders/${order.id}/cancel`, { method: 'POST' })) as Order;
    setOrder(o);
  };

  const lookupOrder = async () => {
    if (!orderId.trim()) return;
    const o = (await api(`${MODULES_BASE}/shopping/orders/${orderId.trim()}`)) as Order;
    setOrder(o);
  };

  return (
    <div>
      <PageHeader title="Shopping" sub="Mock catalog with an approval-gated purchase flow. No real money moves." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>Search products</strong>
        <div className="row-between mt">
          <input
            className="input"
            style={{ flex: 1, marginRight: 8 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the catalog…"
          />
          <button className="btn btn-sm" onClick={refresh}>
            Search
          </button>
        </div>
      </div>

      <div className="grid-2 mt">
        <div>
          <strong className="small">Catalog</strong>
          {(products ?? []).map((p) => (
            <div className="card mt" key={p.id}>
              <div className="row-between">
                <strong>{p.name}</strong>
                <span>{fmtMoney(p.priceCents, p.currency)}</span>
              </div>
              <p className="small muted mt">{p.description}</p>
              <div className="mt">
                <button className="btn btn-sm" onClick={() => void addItem(p.id)}>
                  Add to cart
                </button>
              </div>
            </div>
          ))}
          {(products ?? []).length === 0 && <EmptyState text="No products found." />}
        </div>

        <div>
          <strong className="small">Cart &amp; orders</strong>
          {cart ? (
            <div className="card mt">
              <strong>Cart</strong>
              {cart.items.map((l) => (
                <div key={l.productId} className="row-between small mt">
                  <span>
                    {l.product.name} × {l.qty}
                  </span>
                  <span>{fmtMoney(l.lineTotalCents, cart.currency)}</span>
                </div>
              ))}
              <div className="row-between mt">
                <strong>Total: {fmtMoney(cart.totalCents, cart.currency)}</strong>
                <button className="btn btn-sm" onClick={() => void checkout()}>
                  Checkout
                </button>
              </div>
            </div>
          ) : (
            <p className="small muted mt">Cart is empty.</p>
          )}

          {order && (
            <div className="card mt">
              <div className="row-between">
                <strong className="mono small">{order.id}</strong>
                <span
                  className={`chip${order.status === 'ordered' ? ' green' : order.status === 'cancelled' ? ' red' : ' amber'}`}
                >
                  {order.status}
                </span>
              </div>
              <p className="small mt">Total: {fmtMoney(order.totalCents, order.currency)}</p>
              {order.status === 'pending_approval' && (
                <div className="mt">
                  <p className="small muted">
                    Approval code: <span className="mono">{order.approvalCode}</span>
                  </p>
                  <div className="row-between mt">
                    <input
                      className="input"
                      style={{ flex: 1, marginRight: 8 }}
                      value={approvalCode}
                      onChange={(e) => setApprovalCode(e.target.value)}
                      placeholder="Enter approval code"
                    />
                    <button className="btn btn-sm" onClick={() => void approveOrder()}>
                      Approve
                    </button>
                  </div>
                  <div className="mt">
                    <button className="btn btn-sm" onClick={() => void cancelOrder()}>
                      Cancel order
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="card mt">
            <strong className="small">Look up an order</strong>
            <div className="row-between mt">
              <input
                className="input"
                style={{ flex: 1, marginRight: 8 }}
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                placeholder="Order ID"
              />
              <button className="btn btn-sm" onClick={() => void lookupOrder()}>
                Look up
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

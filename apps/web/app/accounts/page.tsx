// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Accounts page (Phase 4, Workstream C): connected OAuth accounts, the
 * encrypted per-user secret vault, and the (mock-only) wallet.
 *
 * Self-contained in this one file — the UI workstream wires the nav entry.
 * Talks to /api/vault, /api/wallet, /api/accounts/summary, and the existing
 * OAuth endpoints (apps/api/src/oauth.ts). Values from the vault are fetched
 * one at a time and never held in the list state.
 */

import { useCallback, useEffect, useState } from 'react';
import { getApiBase } from '../../lib/api';

const base = () => getApiBase();

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json;
}

interface OAuthStatus {
  id: string;
  name: string;
  connected: boolean;
  expiresAt?: number;
  hasRefreshToken: boolean;
}

interface SecretMeta {
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

interface Secret extends SecretMeta {
  value: string;
}

interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  holderName?: string;
}

interface WalletSummary {
  provider: string;
  mock: boolean;
  chargesEnabled: boolean;
  methods: PaymentMethod[];
}

interface AccountsSummary {
  oauth: OAuthStatus[];
  vault: { secretCount: number };
  wallet: { provider: string; mock: boolean; chargesEnabled: boolean; methodCount: number };
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {hint && <p className="small muted">{hint}</p>}
      {children}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="small" style={{ color: 'var(--danger, #c0392b)' }}>
      {error}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

function ConnectedAccounts() {
  const [statuses, setStatuses] = useState<OAuthStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const summary = await api<AccountsSummary>('GET', '/api/accounts/summary');
      setStatuses(summary.oauth);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = (id: string) => {
    window.location.assign(`${base()}/api/oauth/${id}/start`);
  };

  const disconnect = async (id: string) => {
    setBusy(id);
    try {
      await api('DELETE', `/api/oauth/${id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section title="Connected accounts" hint="OAuth connections (tokens stay encrypted server-side and are never shown).">
      <ErrorLine error={error} />
      {statuses.map((s) => (
        <div key={s.id} className="row-between" style={{ padding: '8px 0' }}>
          <div>
            <strong>{s.name}</strong>{' '}
            <span className={`chip ${s.connected ? 'green' : 'gray'}`}>
              {s.connected ? 'connected' : 'not connected'}
            </span>
            {s.connected && s.hasRefreshToken && <span className="chip green">auto-refresh</span>}
          </div>
          {s.connected ? (
            <button className="btn btn-sm" disabled={busy === s.id} onClick={() => void disconnect(s.id)}>
              Disconnect
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => connect(s.id)}>
              Connect
            </button>
          )}
        </div>
      ))}
      {statuses.length === 0 && <p className="small muted">Loading…</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function VaultPanel() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setSecrets(await api<SecretMeta[]>('GET', '/api/vault'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    setBusy('add');
    try {
      await api('POST', '/api/vault', { name, value, description: description || undefined });
      setName('');
      setValue('');
      setDescription('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const reveal = async (secretName: string) => {
    if (!window.confirm(`Reveal the value of "${secretName}"? It will be visible on screen.`)) return;
    setBusy(secretName);
    try {
      const secret = await api<Secret>('GET', `/api/vault/${encodeURIComponent(secretName)}`);
      setRevealed((prev) => ({ ...prev, [secretName]: secret.value }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const hide = (secretName: string) => {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[secretName];
      return next;
    });
  };

  const remove = async (secretName: string) => {
    if (!window.confirm(`Delete secret "${secretName}"?`)) return;
    setBusy(secretName);
    try {
      await api('DELETE', `/api/vault/${encodeURIComponent(secretName)}`);
      hide(secretName);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section
      title="Secret vault"
      hint="AES-256-GCM encrypted at rest. Names are listed; values are fetched one at a time and never logged."
    >
      <ErrorLine error={error} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          placeholder="name (e.g. openai-key)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="secret value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <input
          className="input"
          placeholder="description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy === 'add' || !name || !value} onClick={() => void add()}>
          Add secret
        </button>
      </div>
      {secrets.map((s) => (
        <div key={s.name} className="row-between" style={{ padding: '8px 0' }}>
          <div>
            <strong>{s.name}</strong>
            {s.description && <span className="small muted"> — {s.description}</span>}
            {revealed[s.name] !== undefined && (
              <code style={{ marginLeft: 8, wordBreak: 'break-all' }}>{revealed[s.name]}</code>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {revealed[s.name] === undefined ? (
              <button className="btn btn-sm" disabled={busy === s.name} onClick={() => void reveal(s.name)}>
                Reveal
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => hide(s.name)}>
                Hide
              </button>
            )}
            <button className="btn btn-sm btn-danger" disabled={busy === s.name} onClick={() => void remove(s.name)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      {secrets.length === 0 && <p className="small muted">No secrets stored.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Wallet (mock only)
// ---------------------------------------------------------------------------

function WalletPanel() {
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [cardNumber, setCardNumber] = useState('');
  const [expMonth, setExpMonth] = useState('');
  const [expYear, setExpYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setWallet(await api<WalletSummary>('GET', '/api/wallet'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    setBusy('add');
    try {
      await api('POST', '/api/wallet/methods', {
        cardNumber,
        expMonth: Number(expMonth),
        expYear: Number(expYear),
      });
      setCardNumber('');
      setExpMonth('');
      setExpYear('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api('DELETE', `/api/wallet/methods/${encodeURIComponent(id)}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <Section
      title="Wallet"
      hint="MOCK wallet — payment methods store only brand + last 4 digits, and charging is disabled. No real money moves."
    >
      <ErrorLine error={error} />
      <p>
        <span className="chip amber">mock only</span>{' '}
        <span className="small muted">charges disabled</span>
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          inputMode="numeric"
          placeholder="card number (mock)"
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value)}
        />
        <input
          className="input"
          inputMode="numeric"
          placeholder="MM"
          value={expMonth}
          onChange={(e) => setExpMonth(e.target.value)}
          style={{ width: 64 }}
        />
        <input
          className="input"
          inputMode="numeric"
          placeholder="YYYY"
          value={expYear}
          onChange={(e) => setExpYear(e.target.value)}
          style={{ width: 80 }}
        />
        <button
          className="btn btn-primary"
          disabled={busy === 'add' || !cardNumber || !expMonth || !expYear}
          onClick={() => void add()}
        >
          Add method
        </button>
      </div>
      {(wallet?.methods ?? []).map((m) => (
        <div key={m.id} className="row-between" style={{ padding: '8px 0' }}>
          <div>
            <strong>{m.brand}</strong> <span className="small muted">•••• {m.last4}</span>{' '}
            <span className="small muted">
              {String(m.expMonth).padStart(2, '0')}/{m.expYear}
            </span>
          </div>
          <button className="btn btn-sm btn-danger" disabled={busy === m.id} onClick={() => void remove(m.id)}>
            Remove
          </button>
        </div>
      ))}
      {(wallet?.methods ?? []).length === 0 && <p className="small muted">No payment methods.</p>}
    </Section>
  );
}

export default function AccountsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1>Accounts</h1>
      <ConnectedAccounts />
      <VaultPanel />
      <WalletPanel />
    </div>
  );
}

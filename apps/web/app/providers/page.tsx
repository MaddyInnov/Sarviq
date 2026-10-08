// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  connectBridge,
  disconnectBridge,
  getProviders,
  removeProviderKey,
  saveProviderKey,
} from '../../lib/api';
import type { ProviderInfo, RateLimitSnapshot } from '../../lib/api';
import { formatResetIn, formatTokens } from '../../lib/usage';

/**
 * Quota line for one provider, e.g. "28/30 req remaining · 1.8M/2M tokens ·
 * resets in 42s". Renders "—" when the provider sent no rate-limit headers.
 */
function RateLimitLine({ rateLimit }: { rateLimit: RateLimitSnapshot | null }) {
  if (!rateLimit) return <p className="small muted">Quota: —</p>;
  const { remainingRequests, limitRequests, remainingTokens, limitTokens, resetAt } = rateLimit;
  const hasAny =
    remainingRequests !== undefined ||
    limitRequests !== undefined ||
    remainingTokens !== undefined ||
    limitTokens !== undefined;
  if (!hasAny) return <p className="small muted">Quota: —</p>;

  const low =
    (remainingRequests !== undefined &&
      limitRequests !== undefined &&
      limitRequests > 0 &&
      remainingRequests / limitRequests < 0.25) ||
    (remainingRequests !== undefined && limitRequests === undefined && remainingRequests <= 5);

  const parts: string[] = [];
  if (remainingRequests !== undefined || limitRequests !== undefined) {
    parts.push(`${remainingRequests ?? '?'}/${limitRequests ?? '?'} req remaining`);
  }
  if (remainingTokens !== undefined || limitTokens !== undefined) {
    const rem = remainingTokens !== undefined ? formatTokens(remainingTokens) : '?';
    const lim = limitTokens !== undefined ? formatTokens(limitTokens) : '?';
    parts.push(`${rem}/${lim} tokens remaining`);
  }
  const reset = formatResetIn(resetAt);
  return (
    <p className="small muted">
      Quota: {parts.join(' · ')}
      {reset && ` · ${reset}`}{' '}
      {low && <span className="chip amber">low</span>}
    </p>
  );
}

function BridgeCard({
  p,
  models,
  freeOnly,
  saving,
  onConnect,
  onDisconnect,
}: {
  p: ProviderInfo;
  /** Model ids to display (already filtered by the "Free only" toggle). */
  models: { id: string; free?: boolean }[];
  freeOnly: boolean;
  saving: string;
  onConnect: (p: ProviderInfo) => void;
  onDisconnect: (p: ProviderInfo) => void;
}) {
  const cliLabel = p.bridge === 'claude' ? 'Claude Code' : 'Codex CLI';
  return (
    <div className="card">
      <div className="row-between">
        <div>
          <strong>{p.name}</strong>{' '}
          <span className={`chip ${p.connected ? 'green' : 'gray'}`}>
            {p.connected ? 'connected' : 'not connected'}
          </span>
        </div>
        <span className="small muted mono">{p.id}</span>
      </div>
      <p className="small muted">
        {models.length > 0
          ? `Models: ${models.map((m) => modelLabel(m.id, m.free)).join(', ')}`
          : freeOnly
            ? 'No free models on this provider.'
            : 'No catalog models.'}
      </p>
      <RateLimitLine rateLimit={p.rateLimit} />
      <div className="warn-box" style={{ marginTop: 8 }}>
        <strong>Use your {cliLabel} login — no API key needed.</strong>
        <br />
        Connecting lets this app read the token your {cliLabel} already stores on this
        machine, only at the moment you chat. The token is kept in memory, never
        saved to disk, never logged, and never sent anywhere except the model
        provider. Disconnecting (or restarting the app) drops it immediately.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {!p.connected ? (
          <button
            className="btn btn-primary btn-sm"
            disabled={saving === p.id}
            onClick={() => onConnect(p)}
          >
            {saving === p.id ? 'Connecting…' : `Connect ${cliLabel} login`}
          </button>
        ) : (
          <button
            className="btn btn-danger btn-sm"
            disabled={saving === p.id}
            onClick={() => onDisconnect(p)}
          >
            {saving === p.id ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
      </div>
    </div>
  );
}

function loadFreeOnly(): boolean {
  try {
    return localStorage.getItem('mvp:freeOnly') === '1';
  } catch {
    return false;
  }
}

function modelLabel(id: string, free?: boolean): string {
  return free ? `${id} (free)` : id;
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState<string>('');
  // "Free only" toggle: filters the model lists below to free models. Default off.
  const [freeOnly, setFreeOnly] = useState<boolean>(() => loadFreeOnly());
  // Per-provider form state.
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<Record<string, string>>({});

  const toggleFreeOnly = (on: boolean) => {
    setFreeOnly(on);
    try {
      localStorage.setItem('mvp:freeOnly', on ? '1' : '0');
    } catch {
      // ignore
    }
  };

  /** Models shown on a provider card, honouring the "Free only" toggle. */
  const shownModels = (p: ProviderInfo) =>
    freeOnly ? p.models.filter((m) => m.free) : p.models;

  const refresh = useCallback(async () => {
    try {
      setProviders(await getProviders());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (p: ProviderInfo) => {
    const apiKey = (keys[p.id] ?? '').trim();
    if (!apiKey) {
      setError('API key is required.');
      return;
    }
    let parsedHeaders: Record<string, string> | undefined;
    const rawHeaders = (headers[p.id] ?? '').trim();
    if (rawHeaders) {
      try {
        const parsed = JSON.parse(rawHeaders) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('must be a JSON object');
        }
        parsedHeaders = parsed as Record<string, string>;
      } catch (err) {
        setError(`Invalid headers JSON: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await saveProviderKey(p.id, apiKey, (baseUrls[p.id] ?? '').trim() || undefined, parsedHeaders);
      setKeys((s) => ({ ...s, [p.id]: '' }));
      setNotice(`Key saved for ${p.name}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  const remove = async (p: ProviderInfo) => {
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await removeProviderKey(p.id);
      setNotice(`Key removed for ${p.name}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  const connect = async (p: ProviderInfo) => {
    if (!p.bridge) return;
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await connectBridge(p.bridge);
      setNotice(`${p.name} connected — using your CLI login.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  const disconnect = async (p: ProviderInfo) => {
    if (!p.bridge) return;
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await disconnectBridge(p.bridge);
      setNotice(`${p.name} disconnected.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  // Bridge providers (Claude/Codex subscriptions) are only surfaced when the
  // CLI or its credential file is detected on this machine.
  const keyProviders = providers.filter((p) => !p.bridge);
  const bridgeProviders = providers.filter((p) => p.bridge && p.detected);

  return (
    <div>
      <h1 className="page-title">Providers</h1>
      <p className="page-sub">Bring your own API keys. The agent uses them for chat completions.</p>
      <div className="warn-box">
        <strong>Key storage:</strong> keys are stored only in environment variables or the local
        file <span className="mono">providers.local.json</span> (mode 0600) next to the API&apos;s
        data directory. They are never logged and never returned by the API.
      </div>
      <div className="row-between" style={{ marginTop: 12 }}>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={freeOnly}
            onChange={(e) => toggleFreeOnly(e.target.checked)}
          />
          <strong>Free only</strong>
          <span className="muted">— show only models that cost $0 to call</span>
        </label>
        {freeOnly && (
          <span className="chip green">free models only</span>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
      {notice && (
        <div className="card" style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}>
          {notice}
        </div>
      )}

      {bridgeProviders.length > 0 && (
        <>
          <h2 className="page-sub" style={{ marginTop: 24 }}>
            Subscription logins
          </h2>
          <p className="small muted">
            Detected on this machine. Connect to run bots on your existing subscription —
            no API key needed.
          </p>
          {bridgeProviders.map((p) => (
            <BridgeCard
              key={p.id}
              p={p}
              models={shownModels(p)}
              freeOnly={freeOnly}
              saving={saving}
              onConnect={connect}
              onDisconnect={disconnect}
            />
          ))}
        </>
      )}

      <h2 className="page-sub" style={{ marginTop: 24 }}>
        API keys
      </h2>
      {keyProviders.map((p) => (
        <div key={p.id} className="card">
          <div className="row-between">
            <div>
              <strong>{p.name}</strong>{' '}
              <span className={`chip ${p.configured ? 'green' : 'gray'}`}>
                {p.configured ? 'configured' : 'no key'}
              </span>
            </div>
            <span className="small muted mono">{p.id}</span>
          </div>
          <p className="small muted">
            {shownModels(p).length > 0
              ? `Models: ${shownModels(p).map((m) => modelLabel(m.id, m.free)).join(', ')}`
              : freeOnly
                ? 'No free models on this provider.'
                : 'No catalog models.'}
          </p>
          <RateLimitLine rateLimit={p.rateLimit} />
          <div className="grid-2">
            <div className="field">
              <label className="label" htmlFor={`key-${p.id}`}>
                API key
              </label>
              <input
                id={`key-${p.id}`}
                className="input mono"
                type="password"
                autoComplete="off"
                placeholder={p.configured ? '•••••••• (saved)' : 'paste key'}
                value={keys[p.id] ?? ''}
                onChange={(e) => setKeys((s) => ({ ...s, [p.id]: e.target.value }))}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={`base-${p.id}`}>
                Base URL override (optional)
              </label>
              <input
                id={`base-${p.id}`}
                className="input mono"
                placeholder="https://…"
                value={baseUrls[p.id] ?? ''}
                onChange={(e) => setBaseUrls((s) => ({ ...s, [p.id]: e.target.value }))}
              />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor={`headers-${p.id}`}>
              Extra headers JSON (optional, for custom endpoints)
            </label>
            <textarea
              id={`headers-${p.id}`}
              className="textarea"
              rows={2}
              placeholder='{"X-Custom": "value"}'
              value={headers[p.id] ?? ''}
              onChange={(e) => setHeaders((s) => ({ ...s, [p.id]: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={saving === p.id}
              onClick={() => void save(p)}
            >
              {saving === p.id ? 'Saving…' : 'Save'}
            </button>
            {p.configured && (
              <button
                className="btn btn-danger btn-sm"
                disabled={saving === p.id}
                onClick={() => void remove(p)}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
      {providers.length === 0 && !error && <p className="muted">Loading providers…</p>}
    </div>
  );
}

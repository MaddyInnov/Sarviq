// SPDX-License-Identifier: Apache-2.0
// Composio connector (Workstream E): lets bots reach 1,000+ external apps
// (Gmail, Slack, GitHub, …) through one Composio API key.
//
// Mount (do NOT edit index.ts; the integrator adds this to routes.ts):
//   import { registerComposioRoutes } from './composio.js';
//   registerComposioRoutes(router, { config, governance, bots });
//
// Routes (registered on the router passed in, relative paths → /api/...):
//   GET    /composio/status            → { connected: boolean }
//   POST   /composio/connect           → { apiKey } → validate → { connected: true }
//   DELETE /composio/connect           → forget the key → { connected: false }
//   GET    /composio/apps[?botId=]     → { connected, apps: ComposioApp[] (+enabled when botId) }
//   POST   /composio/apps/:appId       → { botId, enabled } → per-bot enable toggle
//
// Key handling: the API key is validated against the Composio backend, then
// stored ONLY in the per-user encrypted vault (SecureVault, secret name
// `composio-api-key`). It is never logged, never returned by any endpoint,
// and never appears in audit detail. Without a configured key every endpoint
// answers gracefully ({ connected: false }) — never a 500.
//
// Testing: the Composio HTTP client is behind the ComposioClient interface.
// Production uses fetchComposioClient (real fetch); tests inject a mock via
// deps.composioClient, so zero paid API calls happen in tests.

import express from 'express';
import type { Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecureVault } from '@mvp/vault';
import type { RouteDeps } from './routes.js';

// ---------------------------------------------------------------------------
// Composio HTTP client (interface + production fetch implementation)
// ---------------------------------------------------------------------------

export interface ComposioApp {
  /** Stable Composio toolkit id, e.g. "gmail", "slack". */
  appId: string;
  name: string;
  description?: string;
  logo?: string;
  categories?: string[];
}

export interface ComposioValidateResult {
  ok: boolean;
  orgName?: string;
}

/**
 * Thin HTTP facade over the Composio backend API. Kept behind this interface
 * so tests can inject a deterministic mock — the real client is never used
 * in tests (zero paid API usage).
 */
export interface ComposioClient {
  /** Validate an API key; ok=false when the key is rejected. */
  validateApiKey(apiKey: string): Promise<ComposioValidateResult>;
  /** List available app/toolkits for a validated key. */
  listApps(apiKey: string): Promise<ComposioApp[]>;
}

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

function composioRequest(apiKey: string, path: string) {
  return fetch(`${COMPOSIO_API_BASE}${path}`, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
    // AbortSignal.timeout is available in Node 22; fall back gracefully.
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(12_000) : undefined,
  });
}

function normalizeApp(raw: unknown): ComposioApp {
  const r = (raw ?? {}) as Record<string, unknown>;
  const appId = String(r.app_id ?? r.appId ?? r.slug ?? r.name ?? '');
  return {
    appId,
    name: String(r.name ?? appId),
    description: typeof r.description === 'string' ? r.description : undefined,
    logo: typeof r.logo === 'string' ? r.logo : undefined,
    categories: Array.isArray(r.categories) ? r.categories.map(String) : undefined,
  };
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

/** Production client: real HTTP to backend.composio.dev. Never used in tests. */
export const fetchComposioClient: ComposioClient = {
  async validateApiKey(apiKey: string): Promise<ComposioValidateResult> {
    const res = await composioRequest(apiKey, '/whoami');
    if (isAuthFailure(res.status)) return { ok: false };
    if (!res.ok) throw new Error(`Composio validation failed (HTTP ${res.status})`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const orgName =
      typeof body.org_name === 'string' ? body.org_name : typeof body.name === 'string' ? body.name : undefined;
    return { ok: true, orgName };
  },
  async listApps(apiKey: string): Promise<ComposioApp[]> {
    const res = await composioRequest(apiKey, '/apps');
    if (isAuthFailure(res.status)) throw new Error('Composio rejected the stored API key (HTTP ' + res.status + ')');
    if (!res.ok) throw new Error(`Composio app list failed (HTTP ${res.status})`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const items = Array.isArray(body) ? body : Array.isArray(body.apps) ? body.apps : [];
    return items.map(normalizeApp).filter((a) => a.appId.length > 0);
  },
};

// ---------------------------------------------------------------------------
// Storage: vault (key) + JSON file (per-bot per-app enablement)
// ---------------------------------------------------------------------------

/** Vault secret name holding the Composio API key (per-user namespace). */
export const COMPOSIO_KEY_NAME = 'composio-api-key';

function callerOf(req: Request): string {
  const header = req.header('x-user-id');
  return typeof header === 'string' && header.length > 0 ? header : 'default-user';
}

function sanitizeNamespace(ns: string): string {
  return ns.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'user';
}

/** Per-user enablement file: { [botId]: { [appId]: boolean } }. */
function enablesPath(dataDir: string, userId: string): string {
  const suffix = userId === 'default-user' ? '' : `.${sanitizeNamespace(userId)}`;
  return join(dataDir, `composio-enables${suffix}.json`);
}

function readEnables(dataDir: string, userId: string): Record<string, Record<string, boolean>> {
  try {
    const parsed = JSON.parse(readFileSync(enablesPath(dataDir, userId), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, Record<string, boolean>>;
    }
  } catch {
    // Missing or corrupt file → treat as empty (never 500).
  }
  return {};
}

function writeEnables(dataDir: string, userId: string, state: Record<string, Record<string, boolean>>): void {
  writeFileSync(enablesPath(dataDir, userId), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export type ComposioDeps = Pick<RouteDeps, 'config' | 'governance' | 'bots'> & {
  /** Injected in tests; defaults to the real fetch client in production. */
  composioClient?: ComposioClient;
};

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerComposioRoutes(router: express.Router, deps: ComposioDeps): void {
  const { config, governance, bots } = deps;
  const client: ComposioClient = deps.composioClient ?? fetchComposioClient;

  const vaultOf = (req: Request): SecureVault =>
    new SecureVault(config.dataDir, callerOf(req), callerOf(req));

  /** The stored key, or undefined when not connected. */
  const storedKey = (req: Request): string | undefined => {
    try {
      const secret = vaultOf(req).get(COMPOSIO_KEY_NAME);
      return secret?.value;
    } catch {
      return undefined;
    }
  };

  /** Persist the key: create the vault secret, or update it when present. */
  const saveKey = (req: Request, apiKey: string): void => {
    const vault = vaultOf(req);
    const existing = (() => {
      try {
        return vault.get(COMPOSIO_KEY_NAME);
      } catch {
        return undefined;
      }
    })();
    if (existing) {
      vault.update(COMPOSIO_KEY_NAME, apiKey);
    } else {
      vault.create(COMPOSIO_KEY_NAME, apiKey, 'Composio API key (Workstream E connector)');
    }
  };

  const connectedResponse = (req: Request, res: Response): void => {
    res.json({ connected: storedKey(req) !== undefined });
  };

  const r = express.Router();

  // GET /composio/status — graceful when no key is configured.
  r.get('/status', (req: Request, res: Response) => {
    connectedResponse(req, res);
  });

  // POST /composio/connect — validate the key, then store it in the vault.
  // The key is never logged, never echoed back, never in audit detail.
  r.post('/connect', async (req: Request, res: Response) => {
    const apiKey = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      res.status(400).json({ connected: false, ...errorBody('apiKey is required') });
      return;
    }
    let validation: ComposioValidateResult;
    try {
      validation = await client.validateApiKey(apiKey.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(502)
        .json({ connected: false, ...errorBody('Could not reach the Composio API', message) });
      return;
    }
    if (!validation.ok) {
      res.status(401).json({ connected: false, ...errorBody('Composio rejected the API key') });
      return;
    }
    try {
      saveKey(req, apiKey.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ connected: false, ...errorBody('Failed to store the API key', message) });
      return;
    }
    governance.audit('composio.connected', {
      actor: callerOf(req),
      toolName: 'composio',
      detail: validation.orgName ? { orgName: validation.orgName } : undefined,
    });
    res.json({ connected: true });
  });

  // DELETE /composio/connect — forget the key (idempotent).
  r.delete('/connect', (req: Request, res: Response) => {
    try {
      vaultOf(req).delete(COMPOSIO_KEY_NAME);
    } catch {
      // Unknown/missing secret is fine — the result is "not connected".
    }
    governance.audit('composio.disconnected', { actor: callerOf(req), toolName: 'composio' });
    res.json({ connected: false });
  });

  // GET /composio/apps[?botId=] — catalog of connected apps. Without a key:
  // { connected: false }. With ?botId=, each app carries `enabled` for that bot.
  r.get('/apps', async (req: Request, res: Response) => {
    const apiKey = storedKey(req);
    if (!apiKey) {
      res.json({ connected: false, apps: [] as ComposioApp[] });
      return;
    }
    let apps: ComposioApp[];
    try {
      apps = await client.listApps(apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ connected: true, apps: [] as ComposioApp[], ...errorBody('Could not reach the Composio API', message) });
      return;
    }
    const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined;
    if (!botId) {
      res.json({ connected: true, apps });
      return;
    }
    const enables = readEnables(config.dataDir, callerOf(req));
    const perBot = enables[botId] ?? {};
    res.json({
      connected: true,
      apps: apps.map((a) => ({ ...a, enabled: perBot[a.appId] ?? false })),
    });
  });

  // POST /composio/apps/:appId — enable/disable one app for one bot.
  r.post('/apps/:appId', async (req: Request, res: Response) => {
    const apiKey = storedKey(req);
    if (!apiKey) {
      res
        .status(400)
        .json({ connected: false, ...errorBody('Composio is not connected — connect an API key first') });
      return;
    }
    const body = (req.body ?? {}) as { botId?: unknown; enabled?: unknown };
    if (typeof body.botId !== 'string' || body.botId.length === 0) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json(errorBody('enabled must be a boolean'));
      return;
    }
    const bot = bots.find((b) => b.id === body.botId);
    if (!bot) {
      res.status(404).json(errorBody(`unknown bot: ${body.botId}`));
      return;
    }
    let apps: ComposioApp[];
    try {
      apps = await client.listApps(apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json(errorBody('Could not reach the Composio API', message));
      return;
    }
    const app = apps.find((a) => a.appId === req.params.appId);
    if (!app) {
      res.status(404).json(errorBody(`unknown Composio app: ${req.params.appId}`));
      return;
    }
    const userId = callerOf(req);
    const enables = readEnables(config.dataDir, userId);
    const perBot = enables[body.botId] ?? {};
    perBot[req.params.appId] = body.enabled;
    enables[body.botId] = perBot;
    try {
      writeEnables(config.dataDir, userId, enables);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json(errorBody('Failed to persist the app toggle', message));
      return;
    }
    governance.audit(body.enabled ? 'composio.app_enabled' : 'composio.app_disabled', {
      actor: userId,
      toolName: 'composio',
      detail: { botId: body.botId, appId: req.params.appId },
    });
    res.json({ ok: true, botId: body.botId, appId: req.params.appId, enabled: body.enabled });
  });

  router.use('/composio', r);
}

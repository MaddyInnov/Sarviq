// SPDX-License-Identifier: Apache-2.0
// Tests for apps/api/src/mcp-tools-routes.ts: GET /mcp/tools with scopes and
// PATCH /mcp/tools/:id/scopes toggles. Temp data dirs only; no network.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { McpScopeStore } from '@mvp/agent-runtime';
import type { PlatformToolDef } from '@mvp/agent-runtime';
import { registerMcpToolScopeRoutes } from '../src/mcp-tools-routes.js';

const DEFS: PlatformToolDef[] = [
  { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } },
  { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp:fetch:get', description: 'Fetch a URL.', parameters: { type: 'object', properties: {} } },
];

const fakeServer = { listToolDefs: async () => DEFS };

describe('mcp tool scopes router', () => {
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-tools-api-'));
    const governance = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const scopeStore = new McpScopeStore(join(dir, 'mcp-scopes.db'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerMcpToolScopeRoutes(router, { mcpServer: fakeServer, mcpScopeStore: scopeStore, governance });
    app.use('/api', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('lists tools with required scopes and default-ON toggles', async () => {
    const r = await api('GET', '/mcp/tools');
    expect(r.status).toBe(200);
    const tools = r.json as Array<{ id: string; requiredScope: string; scopes: Record<string, boolean> }>;
    expect(tools.map((t) => t.id).sort()).toEqual(['mcp:fetch:get', 'read_file', 'write_file']);
    const byId = new Map(tools.map((t) => [t.id, t]));
    expect(byId.get('read_file')?.requiredScope).toBe('read');
    expect(byId.get('write_file')?.requiredScope).toBe('write');
    expect(byId.get('mcp:fetch:get')?.requiredScope).toBe('egress');
    for (const t of tools) {
      expect(t.scopes).toEqual({ read: true, write: true, egress: true });
    }
  });

  it('toggles scopes per tool and persists them', async () => {
    const patched = await api('PATCH', '/mcp/tools/mcp:fetch:get/scopes', { egress: false });
    expect(patched.status).toBe(200);
    expect(patched.json.scopes).toEqual({ read: true, write: true, egress: false });
    expect(patched.json.requiredScope).toBe('egress');

    const listed = await api('GET', '/mcp/tools');
    const entry = (listed.json as any[]).find((t) => t.id === 'mcp:fetch:get');
    expect(entry.scopes.egress).toBe(false);

    // Re-enable.
    const re = await api('PATCH', '/mcp/tools/mcp:fetch:get/scopes', { egress: true });
    expect(re.json.scopes.egress).toBe(true);
  });

  it('rejects bad patches and unknown tools', async () => {
    expect((await api('PATCH', '/mcp/tools/read_file/scopes', {})).status).toBe(400);
    expect((await api('PATCH', '/mcp/tools/read_file/scopes', { read: 'no' })).status).toBe(400);
    expect((await api('PATCH', '/mcp/tools/nope/scopes', { read: false })).status).toBe(404);
  });
});

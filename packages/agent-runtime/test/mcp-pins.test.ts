// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  MCPClient,
  MCPSchemaPinStore,
  schemaSha256,
  type SchemaDriftApprovalBroker,
} from '../src/mcp.js';

interface FakeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** In-memory stand-in for the MCP SDK client; no transport or server needed. */
function makeFakeClient(tools: FakeTool[]) {
  return {
    async connect() {},
    async close() {},
    async listTools() {
      return { tools };
    },
    async callTool(req: { name: string; arguments?: Record<string, unknown> }) {
      return { ok: true, name: req.name };
    },
    getServerVersion() {
      return { name: 'fake-server', version: '1.2.3' };
    },
  } as unknown as Client;
}

/** Broker whose decisions the test scripts. */
function makeBroker(decision: 'approved' | 'denied' = 'approved'): SchemaDriftApprovalBroker & {
  requests: Array<{ toolName: string; args: Record<string, unknown> }>;
} {
  const requests: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  return {
    requests,
    requestApproval(toolName, args) {
      const id = `approval_${requests.length}`;
      requests.push({ toolName, args });
      return id;
    },
    async awaitDecision() {
      return decision;
    },
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-pin-test-'));
}

describe('schemaSha256 canonicalization', () => {
  it('hashes semantically identical schemas identically regardless of key order', () => {
    const a = { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number', min: 1 } }, required: ['a'] };
    const b = { required: ['a'], properties: { a: { min: 1, type: 'number' }, z: { type: 'string' } }, type: 'object' };
    expect(schemaSha256(a)).toBe(schemaSha256(b));
  });

  it('hashes different schemas differently', () => {
    const a = { type: 'object', properties: { x: { type: 'string' } } };
    const b = { type: 'object', properties: { x: { type: 'number' } } };
    expect(schemaSha256(a)).not.toBe(schemaSha256(b));
  });
});

describe('MCP TOFU schema pinning', () => {
  it('records pins (sha256 + server version) on first connect', async () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'pins.db');
      const tools: FakeTool[] = [
        { name: 'read_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      ];
      const client = new MCPClient({
        pinDbPath: dbPath,
        createClient: () => makeFakeClient(tools),
      });
      await client.connectStdio({ command: 'fake-server' });

      const store = new MCPSchemaPinStore(dbPath);
      const pin = store.getPin('mcp-stdio:fake-server', 'read_file');
      expect(pin).toBeDefined();
      expect(pin!.schemaSha256).toBe(schemaSha256(tools[0].inputSchema));
      expect(pin!.serverVersion).toBe('1.2.3');
      store.close();
      await client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('silent reconnect with identical schema: no approval requested, tool still runs', async () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'pins.db');
      const schema = { type: 'object', properties: { path: { type: 'string' } } };
      const broker = makeBroker('denied'); // decision must never be consulted
      const client = new MCPClient({
        pinDbPath: dbPath,
        approvalBroker: broker,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: schema }]),
      });
      await client.connectStdio({ command: 'fake-server' });
      await client.close();

      const client2 = new MCPClient({
        pinDbPath: dbPath,
        approvalBroker: broker,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: schema }]),
      });
      await client2.connectStdio({ command: 'fake-server' });
      expect(broker.requests).toHaveLength(0);

      const tools = await client2.listTools();
      const res = await tools[0].handler({ path: '/x' }, { sessionId: 's', botId: 'b' });
      expect(res).toEqual({ ok: true, name: 'read_file' });
      await client2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drift detected: approval requested naming server+tool, tool blocked until approved', async () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'pins.db');
      const v1 = { type: 'object', properties: { path: { type: 'string' } } };
      const v2 = { type: 'object', properties: { path: { type: 'string' }, extra: { type: 'string' } } };

      const first = new MCPClient({
        pinDbPath: dbPath,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v1 }]),
      });
      await first.connectStdio({ command: 'fake-server' });
      await first.close();

      // Reconnect with a changed schema; human denies.
      const broker = makeBroker('denied');
      const second = new MCPClient({
        pinDbPath: dbPath,
        approvalBroker: broker,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v2 }]),
      });
      await second.connectStdio({ command: 'fake-server' });
      expect(broker.requests).toHaveLength(1);
      const [req] = broker.requests;
      expect(req.toolName).toBe('mcp:read_file');
      expect(req.args['reason']).toBe('mcp-schema-drift');
      expect(String(req.args['message'])).toContain('fake-server');
      expect(String(req.args['message'])).toContain('read_file');
      expect(req.args['serverLabel']).toBe('mcp-stdio:fake-server');

      const tools = await second.listTools();
      await expect(
        tools[0].handler({ path: '/x' }, { sessionId: 's', botId: 'b' }),
      ).rejects.toThrow(/blocked/);

      // Fresh session reconnecting with the same drift may re-ask (deny only
      // holds for the session that denied it); the tool stays blocked.
      const third = new MCPClient({
        pinDbPath: dbPath,
        approvalBroker: broker,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v2 }]),
      });
      await third.connectStdio({ command: 'fake-server' });
      expect(broker.requests).toHaveLength(2);
      const tools3 = await third.listTools();
      await expect(
        tools3[0].handler({ path: '/x' }, { sessionId: 's', botId: 'b' }),
      ).rejects.toThrow(/blocked/);

      await second.close();
      await third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drift approved: pin updated, tool runs, later reconnect silent', async () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'pins.db');
      const v1 = { type: 'object', properties: { path: { type: 'string' } } };
      const v2 = { type: 'object', properties: { path: { type: 'string' }, extra: { type: 'string' } } };

      const first = new MCPClient({
        pinDbPath: dbPath,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v1 }]),
      });
      await first.connectStdio({ command: 'fake-server' });
      await first.close();

      const broker = makeBroker('approved');
      const second = new MCPClient({
        pinDbPath: dbPath,
        approvalBroker: broker,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v2 }]),
      });
      await second.connectStdio({ command: 'fake-server' });
      expect(broker.requests).toHaveLength(1);

      const tools = await second.listTools();
      const res = await tools[0].handler({ path: '/x' }, { sessionId: 's', botId: 'b' });
      expect(res).toEqual({ ok: true, name: 'read_file' });
      await second.close();

      // Pin now holds v2: next reconnect with v2 is silent.
      const broker2 = makeBroker('denied');
      const third = new MCPClient({
        pinDbPath: dbPath,
        approvalBroker: broker2,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v2 }]),
      });
      await third.connectStdio({ command: 'fake-server' });
      expect(broker2.requests).toHaveLength(0);
      await third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drift with no broker fails closed: tool blocked, connect still succeeds', async () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'pins.db');
      const v1 = { type: 'object', properties: { path: { type: 'string' } } };
      const v2 = { type: 'object', properties: { path: { type: 'string' }, extra: { type: 'string' } } };

      const first = new MCPClient({
        pinDbPath: dbPath,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v1 }]),
      });
      await first.connectStdio({ command: 'fake-server' });
      await first.close();

      const second = new MCPClient({
        pinDbPath: dbPath, // no approvalBroker
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v2 }]),
      });
      await second.connectStdio({ command: 'fake-server' });
      const tools = await second.listTools();
      await expect(
        tools[0].handler({ path: '/x' }, { sessionId: 's', botId: 'b' }),
      ).rejects.toThrow(/blocked/);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schema reverting to the pinned form silently unblocks', async () => {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'pins.db');
      const v1 = { type: 'object', properties: { path: { type: 'string' } } };
      const v2 = { type: 'object', properties: { path: { type: 'string' }, extra: { type: 'string' } } };

      const first = new MCPClient({
        pinDbPath: dbPath,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v1 }]),
      });
      await first.connectStdio({ command: 'fake-server' });
      await first.close();

      const second = new MCPClient({
        pinDbPath: dbPath,
        approvalBroker: makeBroker('denied'),
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v2 }]),
      });
      await second.connectStdio({ command: 'fake-server' });
      await second.close();

      // Server reverts to v1: reconnect is silent and the tool runs again.
      const broker = makeBroker('denied');
      const third = new MCPClient({
        pinDbPath: dbPath,
        approvalBroker: broker,
        createClient: () => makeFakeClient([{ name: 'read_file', inputSchema: v1 }]),
      });
      await third.connectStdio({ command: 'fake-server' });
      expect(broker.requests).toHaveLength(0);
      const tools = await third.listTools();
      const res = await tools[0].handler({ path: '/x' }, { sessionId: 's', botId: 'b' });
      expect(res).toEqual({ ok: true, name: 'read_file' });
      await third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('works without pinDbPath: legacy connect/list/call flow unchanged', async () => {
    const tools: FakeTool[] = [
      { name: 'read_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    ];
    const client = new MCPClient({ createClient: () => makeFakeClient(tools) });
    await client.connectStdio({ command: 'fake-server' });
    const listed = await client.listTools();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('mcp:read_file');
    const res = await listed[0].handler({ path: '/x' }, { sessionId: 's', botId: 'b' });
    expect(res).toEqual({ ok: true, name: 'read_file' });
    await client.close();
  });
});

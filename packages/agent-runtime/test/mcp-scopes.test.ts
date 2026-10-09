// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { ToolCall } from '../src/types.js';
import {
  McpScopeStore,
  parseScopePatch,
  requiredScopeForTool,
} from '../src/mcp-scopes.js';
import {
  PlatformMcpServer,
  type ToolProvider,
} from '../src/mcp-server.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'mcp-scopes-test-')), 'mcp-scopes.db');
}

const stores: McpScopeStore[] = [];
function freshStore(): McpScopeStore {
  const s = new McpScopeStore(tmpDb());
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

describe('requiredScopeForTool', () => {
  it('classifies tools by nature', () => {
    expect(requiredScopeForTool('read_file')).toBe('read');
    expect(requiredScopeForTool('memory_recall')).toBe('read');
    expect(requiredScopeForTool('list_dir')).toBe('read');
    expect(requiredScopeForTool('write_file')).toBe('write');
    expect(requiredScopeForTool('memory_store')).toBe('write');
    expect(requiredScopeForTool('run_command')).toBe('write');
    expect(requiredScopeForTool('mcp:fetch:get_page')).toBe('egress');
    expect(requiredScopeForTool('send_message')).toBe('egress');
    expect(requiredScopeForTool('webhook_notify')).toBe('egress');
    expect(requiredScopeForTool('web_fetch')).toBe('egress');
    expect(requiredScopeForTool('chat')).toBe('egress'); // always calls the cloud LLM
  });
});

describe('McpScopeStore', () => {
  it('defaults to all scopes ON and persists toggles', () => {
    const store = freshStore();
    expect(store.get('read_file')).toEqual({ read: true, write: true, egress: true });

    const next = store.set('read_file', { read: false });
    expect(next).toEqual({ read: false, write: true, egress: true });
    // Omitted keys keep their values.
    expect(store.set('read_file', { egress: false })).toEqual({
      read: false,
      write: true,
      egress: false,
    });
    expect(store.get('read_file').read).toBe(false);

    const overrides = store.listOverrides();
    expect(overrides.length).toBe(1);
    expect(overrides[0].tool).toBe('read_file');
  });

  it('check() reports the required scope and whether it is granted', () => {
    const store = freshStore();
    store.set('mcp:fetch:get', { egress: false });
    const c = store.check('mcp:fetch:get');
    expect(c.required).toBe('egress');
    expect(c.granted).toBe(false);
    expect(store.check('read_file').granted).toBe(true);
  });

  it('rejects bad input', () => {
    const store = freshStore();
    expect(() => store.set('', { read: false })).toThrow(/non-empty string/);
    expect(() => store.set('x', { read: 'yes' as unknown as boolean })).toThrow(/booleans/);
  });
});

describe('parseScopePatch', () => {
  it('accepts partial boolean patches', () => {
    expect(parseScopePatch({ egress: false })).toEqual({ egress: false });
    expect(parseScopePatch({ read: true, write: false })).toEqual({ read: true, write: false });
  });
  it('rejects empty and malformed bodies', () => {
    expect(() => parseScopePatch({})).toThrow(/at least one/);
    expect(() => parseScopePatch({ foo: true })).toThrow(/at least one/);
    expect(() => parseScopePatch(null)).toThrow(/must be an object/);
    expect(() => parseScopePatch({ read: 'no' })).toThrow(/booleans/);
  });
});

// ---- Server enforcement ----------------------------------------------------

type FakeGovernance = Pick<GovernanceGateway, 'classify' | 'evaluate' | 'audit'>;

function fakeGovernance(): FakeGovernance {
  return {
    classify: (_call: ToolCall) => 'allow' as GovernanceDecision,
    evaluate: async (_call: ToolCall) => ({ decision: 'allow' as GovernanceDecision }),
    audit: () => undefined,
  };
}

function fakeProvider(calls: string[]): ToolProvider {
  return {
    listTools: () => [
      { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {} } },
      { name: 'mcp:fetch:get', description: 'Fetch a URL.', parameters: { type: 'object', properties: {} } },
    ],
    callTool: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  };
}

function makeServer(calls: string[], scopes: McpScopeStore) {
  return new PlatformMcpServer({
    tools: fakeProvider(calls),
    governance: fakeGovernance(),
    botId: 'test-bot',
    scopes,
  });
}

async function callTool(server: PlatformMcpServer, name: string): Promise<{ isError?: boolean; text: string }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  try {
    const result = (await client.callTool({ name, arguments: {} })) as unknown as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    return { isError: result.isError, text: result.content.map((c) => c.text ?? '').join('') };
  } finally {
    await client.close();
    await server.close();
  }
}

function payload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('PlatformMcpServer scope enforcement', () => {
  it('denies calls whose required scope is disabled, with a clear error', async () => {
    const calls: string[] = [];
    const scopes = freshStore();
    scopes.set('read_file', { read: false });
    scopes.set('mcp:fetch:get', { egress: false });
    const server = makeServer(calls, scopes);

    const deniedRead = await callTool(server, 'read_file');
    expect(deniedRead.isError).toBe(true);
    const p1 = payload(deniedRead.text);
    expect(p1['code']).toBe('scope_denied');
    expect(p1['requiredScope']).toBe('read');
    expect(String(p1['message'])).toMatch(/requires the "read" scope/);
    expect(String(p1['message'])).toMatch(/PATCH \/api\/mcp\/tools/);

    const deniedEgress = await callTool(server, 'mcp:fetch:get');
    const p2 = payload(deniedEgress.text);
    expect(p2['code']).toBe('scope_denied');
    expect(p2['requiredScope']).toBe('egress');

    // The tool implementations never ran.
    expect(calls).toEqual([]);
  });

  it('allows calls when the required scope is ON, even if others are off', async () => {
    const calls: string[] = [];
    const scopes = freshStore();
    scopes.set('read_file', { write: false, egress: false }); // read stays on
    const server = makeServer(calls, scopes);

    const res = await callTool(server, 'read_file');
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(['read_file']);
  });

  it('re-enabling the scope restores the tool', async () => {
    const calls: string[] = [];
    const scopes = freshStore();
    const server = makeServer(calls, scopes);
    scopes.set('read_file', { read: false });
    expect(payload((await callTool(server, 'read_file')).text)['code']).toBe('scope_denied');
    scopes.set('read_file', { read: true });
    const res = await callTool(server, 'read_file');
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(['read_file']);
  });

  it('listToolDefs() exposes tools for the settings API', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, freshStore());
    const defs = await server.listToolDefs();
    expect(defs.map((d) => d.name).sort()).toEqual(['mcp:fetch:get', 'read_file']);
  });
});

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { ToolCall } from '../src/types.js';
import {
  PlatformMcpServer,
  toolProviderFromRegistry,
  type ToolProvider,
} from '../src/mcp-server.js';

type FakeGovernance = Pick<GovernanceGateway, 'classify' | 'evaluate' | 'audit'>;

function fakeGovernance(decisions: Record<string, GovernanceDecision>): FakeGovernance {
  return {
    classify: (call: ToolCall) => decisions[call.name] ?? 'allow',
    evaluate: async (call: ToolCall) => ({ decision: decisions[call.name] ?? 'allow' }),
    audit: () => undefined,
  };
}

function fakeProvider(calls: string[]): ToolProvider {
  return {
    listTools: () => [
      {
        name: 'read_file',
        description: 'Read a file (safe).',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'run_command',
        description: 'Run a shell command (sensitive).',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
      },
      {
        name: 'send_message',
        description: 'Send a message (blocked).',
        parameters: { type: 'object', properties: { to: { type: 'string' } } },
      },
    ],
    callTool: async (name, args) => {
      calls.push(name);
      return { ok: true, name, args };
    },
  };
}

function makeServer(calls: string[], decisions: Record<string, GovernanceDecision>) {
  return new PlatformMcpServer({
    tools: fakeProvider(calls),
    governance: fakeGovernance(decisions),
    botId: 'test-bot',
    sessionId: 'test-session',
    chat: {
      handler: async (message) => {
        calls.push('chat');
        return { reply: `echo: ${message}` };
      },
    },
  });
}

const DECISIONS: Record<string, GovernanceDecision> = {
  read_file: 'allow',
  run_command: 'require-approval',
  send_message: 'deny',
  chat: 'allow',
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('PlatformMcpServer tool listing', () => {
  it('lists provider tools plus the chat tool', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['chat', 'read_file', 'run_command', 'send_message']);
      const readFile = tools.find((t) => t.name === 'read_file')!;
      expect(readFile.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('omits the chat tool when no chat handler is wired', async () => {
    const calls: string[] = [];
    const server = new PlatformMcpServer({
      tools: fakeProvider(calls),
      governance: fakeGovernance(DECISIONS),
      botId: 'test-bot',
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain('chat');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('PlatformMcpServer call dispatch + approval policy', () => {
  it('executes allowed tools immediately', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const res = await (server as unknown as { handleCallTool(n: string, a: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> }).handleCallTool(
      'read_file',
      { path: '/tmp/x' },
    );
    expect(res.isError).not.toBe(true);
    expect(calls).toEqual(['read_file']);
    expect(textOf(res)).toContain('read_file');
  });

  it('require-approval tools are NOT executed silently; approval handshake works', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const handle = server as unknown as {
      handleCallTool(n: string, a: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };

    // 1. First call → approval_required, provider untouched.
    const pending = await handle.handleCallTool('run_command', { cmd: 'ls' });
    expect(pending.isError).not.toBe(true);
    const body = JSON.parse(textOf(pending)) as { status: string; approvalId: string };
    expect(body.status).toBe('approval_required');
    expect(typeof body.approvalId).toBe('string');
    expect(calls).toEqual([]);

    // 2. Host approves out-of-band; identical re-call executes exactly once.
    expect(server.decideApproval(body.approvalId, 'approved')).toBe(true);
    const done = await handle.handleCallTool('run_command', { cmd: 'ls' });
    expect(done.isError).not.toBe(true);
    expect(calls).toEqual(['run_command']);

    // 3. The grant is single-use: another identical call needs approval again.
    const pending2 = await handle.handleCallTool('run_command', { cmd: 'ls' });
    expect(JSON.parse(textOf(pending2)).status).toBe('approval_required');
    expect(calls).toEqual(['run_command']);
  });

  it('grants are argument-bound: approval for one args set does not cover another', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const handle = server as unknown as {
      handleCallTool(n: string, a: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };
    const pending = await handle.handleCallTool('run_command', { cmd: 'ls' });
    const { approvalId } = JSON.parse(textOf(pending)) as { approvalId: string };
    expect(server.decideApproval(approvalId, 'approved')).toBe(true);
    // Different args → no grant applies → approval required again, not executed.
    const other = await handle.handleCallTool('run_command', { cmd: 'rm -rf /' });
    expect(JSON.parse(textOf(other)).status).toBe('approval_required');
    expect(calls).toEqual([]);
  });

  it('denied approvals never execute', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const handle = server as unknown as {
      handleCallTool(n: string, a: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };
    const pending = await handle.handleCallTool('run_command', { cmd: 'ls' });
    const { approvalId } = JSON.parse(textOf(pending)) as { approvalId: string };
    expect(server.decideApproval(approvalId, 'denied')).toBe(true);
    const retry = await handle.handleCallTool('run_command', { cmd: 'ls' });
    expect(JSON.parse(textOf(retry)).status).toBe('approval_required');
    expect(calls).toEqual([]);
  });

  it('deny verdicts stay denied and never execute', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const handle = server as unknown as {
      handleCallTool(n: string, a: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };
    const res = await handle.handleCallTool('send_message', { to: 'x' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).status).toBe('denied');
    expect(calls).toEqual([]);
  });

  it('governance errors fail closed to deny', async () => {
    const calls: string[] = [];
    const server = new PlatformMcpServer({
      tools: fakeProvider(calls),
      governance: {
        classify: () => 'allow',
        evaluate: async () => {
          throw new Error('policy exploded');
        },
        audit: () => undefined,
      },
      botId: 'test-bot',
    });
    const handle = server as unknown as {
      handleCallTool(n: string, a: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };
    const res = await handle.handleCallTool('read_file', { path: 'x' });
    expect(JSON.parse(textOf(res)).status).toBe('denied');
    expect(calls).toEqual([]);
  });

  it('unknown tools return a structured error', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const handle = server as unknown as {
      handleCallTool(n: string, a: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };
    const res = await handle.handleCallTool('nope', {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).code).toBe('unknown_tool');
  });

  it('decideApproval returns false for unknown approval ids', () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    expect(server.decideApproval('bogus', 'approved')).toBe(false);
  });

  it('chat tool invokes the bot-turn handler', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const handle = server as unknown as {
      handleCallTool(n: string, a: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    };
    const res = await handle.handleCallTool('chat', { message: 'hello' });
    expect(calls).toEqual(['chat']);
    expect(textOf(res)).toContain('echo: hello');
  });

  it('toolProviderFromRegistry adapts a Map<string, ToolDefinition>', async () => {
    const registry = new Map([
      [
        'ping',
        {
          name: 'ping',
          description: 'pong',
          parameters: { type: 'object' },
          handler: async () => 'pong',
        },
      ],
    ]);
    const provider = toolProviderFromRegistry(registry);
    expect((await provider.listTools()).map((t) => t.name)).toEqual(['ping']);
    expect(await provider.callTool('ping', {})).toBe('pong');
  });
});

describe('PlatformMcpServer transports', () => {
  it('serves list/call end-to-end over an in-memory transport (stdio-shaped)', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await server.connect(serverT);
    await client.connect(clientT);
    try {
      const call = (await client.callTool({ name: 'read_file', arguments: { path: '/x' } })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      expect(call.isError).not.toBe(true);
      expect(calls).toEqual(['read_file']);
      // Untrusted-output provenance tag rides along to the external client.
      expect(textOf(call)).toContain('untrusted data');

      const blocked = (await client.callTool({
        name: 'run_command',
        arguments: { cmd: 'ls' },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(JSON.parse(textOf(blocked)).status).toBe('approval_required');
      expect(calls).toEqual(['read_file']);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('serves over HTTP+SSE on an ephemeral port', async () => {
    const calls: string[] = [];
    const server = makeServer(calls, DECISIONS);
    const http = await server.serveHttp({ port: 0 });
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    const transport = new SSEClientTransport(new URL(http.url));
    await client.connect(transport);
    try {
      expect(http.port).toBeGreaterThan(0);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('read_file');
      const call = (await client.callTool({ name: 'read_file', arguments: { path: '/x' } })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      expect(call.isError).not.toBe(true);
      expect(calls).toEqual(['read_file']);
    } finally {
      await client.close();
      await http.close();
    }
  }, 30000);
});

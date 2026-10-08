// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  MCPTaskManager,
  MockMCPTaskServer,
  createMCPTaskTools,
  mcpTaskToolName,
  type MCPTask,
} from '../src/mcp-tasks.js';

describe('mcp:<server>: task tool naming', () => {
  it('follows the mcp.ts naming rule', () => {
    expect(mcpTaskToolName('fetch', 'tasks_create')).toBe('mcp:fetch:tasks_create');
    expect(mcpTaskToolName(undefined, 'tasks_create')).toBe('mcp:tasks_create');
    expect(mcpTaskToolName('a:b', 'tasks_status')).toBe('mcp:a_b:tasks_status');
  });

  it('exposes four tools with JSON schemas', () => {
    const tools = createMCPTaskTools({ serverName: 'demo' });
    expect(tools.map((t) => t.name)).toEqual([
      'mcp:demo:tasks_create',
      'mcp:demo:tasks_status',
      'mcp:demo:tasks_cancel',
      'mcp:demo:tasks_result',
    ]);
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: 'object' });
      expect(typeof tool.handler).toBe('function');
    }
  });
});

describe('MockMCPTaskServer round-trip', () => {
  it('creates → status → completes → result', async () => {
    const server = new MockMCPTaskServer('mock-tasks');
    const manager = server.manager('mock-tasks');

    const created = await manager.create('summarize doc', { doc: 'abc' });
    expect(created.status).toBe('created');
    expect(created.title).toBe('summarize doc');

    const status = await manager.status(created.id);
    expect(status).toMatchObject({ id: created.id, status: 'created' });

    // Simulate the worker finishing via the store (the "remote" side).
    server.store.setStatus(created.id, 'running');
    server.store.setStatus(created.id, 'completed', { result: { summary: 'done' } });

    const result = await manager.result(created.id);
    expect(result).toMatchObject({
      id: created.id,
      status: 'completed',
      result: { summary: 'done' },
    });
  });

  it('result throws before completion', async () => {
    const server = new MockMCPTaskServer();
    const manager = server.manager();
    const task = await manager.create('slow job');
    await expect(manager.result(task.id)).rejects.toThrow(/no result yet/);
  });

  it('cancels a pending task', async () => {
    const server = new MockMCPTaskServer();
    const manager = server.manager();
    const task = await manager.create('to cancel');
    const cancelled = await manager.cancel(task.id);
    expect(cancelled.status).toBe('cancelled');
    await expect(manager.cancel(task.id)).rejects.toThrow(/already terminal/);
  });

  it('rejects unknown task ids', async () => {
    const server = new MockMCPTaskServer();
    const manager = server.manager();
    await expect(manager.status('nope')).rejects.toThrow(/unknown MCP task/);
  });

  it('validates the create title', async () => {
    const server = new MockMCPTaskServer();
    const manager = server.manager();
    await expect(manager.create('   ')).rejects.toThrow(/"title"/);
  });

  it('routes through the tool channel with ToolContext', async () => {
    const server = new MockMCPTaskServer('ctx-check');
    const seen: Array<{ tool: string; ctx: unknown }> = [];
    const manager = new MCPTaskManager(
      async (toolName, args, ctx) => {
        seen.push({ tool: toolName, ctx });
        const tool = server.registry.get(toolName);
        if (!tool) throw new Error('missing tool');
        return tool.handler(args, ctx);
      },
      'ctx-check',
      { sessionId: 's1', botId: 'b1' },
    );
    const task = (await manager.create('x')) as MCPTask;
    expect(seen[0]?.tool).toBe('mcp:ctx-check:tasks_create');
    expect(seen[0]?.ctx).toMatchObject({ sessionId: 's1', botId: 'b1' });
    expect(task.id).toBeTruthy();
  });
});

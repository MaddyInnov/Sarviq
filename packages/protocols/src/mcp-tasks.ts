// SPDX-License-Identifier: Apache-2.0
// MCP Tasks: task creation / status / cancellation / result carried over the
// MCP tool channel.
//
// Conventions followed (see packages/agent-runtime/src/mcp.ts):
//   - Tools are plain ToolDefinitions with JSON-schema passthrough, exactly
//     what MCPClient.listTools() returns — the agent loop uses them like any
//     other tool, so deny-by-default governance and approval gating apply.
//   - Registered names follow the `mcp:<server>:<tool>` rule (same segment
//     separator, same ':'-sanitization of the server label).
//   - The task backend is injectable (MCPTaskStore interface): in-memory here
//     for hermetic tests; a real MCP server can back it later without
//     changing the client (MCPTaskManager).
//
// Tool surface (one per lifecycle operation):
//   mcp:<server>:tasks_create { title, input? } → task record (created)
//   mcp:<server>:tasks_status { id }           → task record
//   mcp:<server>:tasks_cancel { id }           → task record (cancelled)
//   mcp:<server>:tasks_result { id }           → { id, status, result? }

import { randomUUID } from 'node:crypto';

/** Minimal ToolDefinition/ToolContext shapes (mirrors @mvp/agent-runtime types; kept local so this package has no runtime dep). */
export interface McpTaskToolContext {
  sessionId: string;
  botId: string;
}

export interface McpTaskToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: McpTaskToolContext) => Promise<unknown>;
}

/** MCP task lifecycle. */
export type MCPTaskStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MCPTask {
  id: string;
  title: string;
  status: MCPTaskStatus;
  /** Opaque input the task was created with. */
  input: unknown;
  /** Opaque result, present once status === 'completed'. */
  result?: unknown;
  /** Failure detail when status === 'failed'. */
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Task backend. In-memory default below; swap in a real MCP server adapter
 * later — MCPTaskManager only talks to this interface.
 */
export interface MCPTaskStore {
  create(title: string, input: unknown): MCPTask;
  get(id: string): MCPTask | undefined;
  setStatus(id: string, status: MCPTaskStatus, extra?: { result?: unknown; error?: string }): MCPTask;
  list(): MCPTask[];
}

const TERMINAL: ReadonlySet<MCPTaskStatus> = new Set(['completed', 'failed', 'cancelled']);

/** In-memory task store (hermetic; tasks die with the process — same contract as the A2A in-memory transport). */
export class InMemoryMCPTaskStore implements MCPTaskStore {
  private readonly tasks = new Map<string, MCPTask>();

  create(title: string, input: unknown): MCPTask {
    const task: MCPTask = {
      id: `mcp_task_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      title,
      status: 'created',
      input: input ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    return { ...task };
  }

  get(id: string): MCPTask | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task } : undefined;
  }

  setStatus(id: string, status: MCPTaskStatus, extra?: { result?: unknown; error?: string }): MCPTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown MCP task "${id}"`);
    if (TERMINAL.has(task.status)) {
      throw new Error(`MCP task "${id}" is already terminal (${task.status})`);
    }
    task.status = status;
    task.updatedAt = Date.now();
    if (extra?.result !== undefined) task.result = extra.result;
    if (extra?.error !== undefined) task.error = extra.error;
    return { ...task };
  }

  list(): MCPTask[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }
}

/**
 * Registered tool name for an MCP task tool. Same rule as
 * `mcpToolName()` in agent-runtime/src/mcp.ts: `mcp:<server>:<tool>` when
 * the server is named, else the legacy `mcp:<tool>`; ':' in the server label
 * is sanitized to '_' so policy patterns like `^mcp:<server>:` stay
 * predictable. (Inlined so this package has no agent-runtime dependency.)
 */
export function mcpTaskToolName(serverName: string | undefined, toolName: string): string {
  if (!serverName) return `mcp:${toolName}`;
  return `mcp:${serverName.replace(/:/g, '_')}:${toolName}`;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return v.trim();
}

/**
 * Build the four MCP task ToolDefinitions, wired to `store`. Register them
 * into a Map<string, ToolDefinition> (what the agent runtime expects) with
 * the standard `mcp:<server>:` prefix. A name collision with an existing
 * entry throws — the registry owner decides how to resolve it.
 */
export function createMCPTaskTools(opts: {
  serverName?: string;
  store?: MCPTaskStore;
} = {}): McpTaskToolDefinition[] {
  const store = opts.store ?? new InMemoryMCPTaskStore();
  const n = (tool: string) => mcpTaskToolName(opts.serverName, tool);

  const createTool: McpTaskToolDefinition = {
    name: n('tasks_create'),
    description: 'Create an MCP task: { title, input? } → task record with status "created".',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable task title' },
        input: { description: 'Opaque input payload for the task' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: async (args) => store.create(strArg(args, 'title'), args['input'] ?? null),
  };

  const statusTool: McpTaskToolDefinition = {
    name: n('tasks_status'),
    description: 'Get the current status of an MCP task: { id } → task record.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id from tasks_create' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const task = store.get(strArg(args, 'id'));
      if (!task) throw new Error(`unknown MCP task "${args['id']}"`);
      return task;
    },
  };

  const cancelTool: McpTaskToolDefinition = {
    name: n('tasks_cancel'),
    description: 'Cancel a non-terminal MCP task: { id } → task record with status "cancelled".',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id from tasks_create' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => store.setStatus(strArg(args, 'id'), 'cancelled'),
  };

  const resultTool: McpTaskToolDefinition = {
    name: n('tasks_result'),
    description: 'Fetch an MCP task result: { id } → { id, status, result?, error? }. Throws unless the task completed.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id from tasks_create' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const task = store.get(strArg(args, 'id'));
      if (!task) throw new Error(`unknown MCP task "${args['id']}"`);
      if (task.status !== 'completed') {
        throw new Error(`MCP task "${task.id}" has no result yet (status: ${task.status})`);
      }
      return { id: task.id, status: task.status, result: task.result ?? null };
    },
  };

  return [createTool, statusTool, cancelTool, resultTool];
}

/** Channel abstraction: how tool calls reach the MCP server. */
export type MCPTaskChannel = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpTaskToolContext,
) => Promise<unknown>;

/**
 * Client-side helper: task creation / status / cancellation / result over
 * the MCP channel. Construct with the channel; the tool names encode the
 * server (mcp:<server>:tasks_*).
 */
export class MCPTaskManager {
  constructor(
    private readonly channel: MCPTaskChannel,
    private readonly serverName?: string,
    private readonly ctx: McpTaskToolContext = { sessionId: 'mcp-tasks', botId: 'mcp-tasks' },
  ) {}

  private call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return this.channel(mcpTaskToolName(this.serverName, tool), args, this.ctx);
  }

  async create(title: string, input?: unknown): Promise<MCPTask> {
    return (await this.call('tasks_create', { title, input: input ?? null })) as MCPTask;
  }

  async status(id: string): Promise<MCPTask> {
    return (await this.call('tasks_status', { id })) as MCPTask;
  }

  async cancel(id: string): Promise<MCPTask> {
    return (await this.call('tasks_cancel', { id })) as MCPTask;
  }

  async result(id: string): Promise<{ id: string; status: MCPTaskStatus; result: unknown }> {
    return (await this.call('tasks_result', { id })) as { id: string; status: MCPTaskStatus; result: unknown };
  }
}

/**
 * Mock MCP task server for tests: the four tools registered into a Map and
 * a channel that dispatches to them — the full client→server round trip
 * without any MCP wire protocol.
 */
export class MockMCPTaskServer {
  readonly store = new InMemoryMCPTaskStore();
  readonly registry = new Map<string, McpTaskToolDefinition>();

  constructor(serverName = 'mock-tasks') {
    for (const tool of createMCPTaskTools({ serverName, store: this.store })) {
      this.registry.set(tool.name, tool);
    }
  }

  channel(): MCPTaskChannel {
    return async (toolName, args, ctx) => {
      const tool = this.registry.get(toolName);
      if (!tool) throw new Error(`mock MCP task server: unknown tool "${toolName}"`);
      return tool.handler(args, ctx);
    };
  }

  manager(serverName = 'mock-tasks'): MCPTaskManager {
    return new MCPTaskManager(this.channel(), serverName);
  }
}

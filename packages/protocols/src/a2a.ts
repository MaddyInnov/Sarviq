// SPDX-License-Identifier: Apache-2.0
// A2A (agent-to-agent) interop: agent card data model, JSON-RPC message
// handling, and task lifecycle over an in-memory transport.
//
// This is a faithful-but-compact implementation of the A2A shape the MVP
// needs: a server exposes an agent card and answers JSON-RPC 2.0 calls
// (`message/send`, `tasks/get`, `tasks/cancel`); a client drives it through
// an InMemoryA2ATransport. No network, no paid usage — everything runs
// in-process so tests (and the API routes) stay hermetic. A MockA2APeer
// provides a canned remote agent for round-trip tests.

import { randomUUID } from 'node:crypto';

/** A capability the agent advertises on its card (A2A agent-card shape). */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  /** Example prompts a client can send to exercise this skill. */
  examples?: string[];
}

/**
 * A2A agent card (`/.well-known/agent-card.json`). Data model only — the
 * API layer (apps/api/src/protocols.ts) serves it over HTTP.
 */
export interface AgentCard {
  name: string;
  description: string;
  /** Base URL where this agent's A2A JSON-RPC endpoint lives. */
  url: string;
  version: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  skills: AgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  authentication?: { schemes: string[] };
}

/** The card this platform advertises for its own A2A endpoint. */
export function defaultAgentCard(baseUrl: string): AgentCard {
  return {
    name: 'MVP Agent',
    description:
      'Approval-gated AI agent: chat, tool use, workflows, and computer use. All mutating actions require human approval.',
    url: baseUrl,
    version: '0.1.0',
    capabilities: { streaming: true, pushNotifications: false },
    skills: [
      {
        id: 'chat',
        name: 'chat',
        description: 'Conversational task execution with tool use.',
        examples: ['Summarize this document', 'Search the web for…'],
      },
      {
        id: 'computer-use',
        name: 'computer-use',
        description: 'Sandboxed GUI automation (screenshot, click, type, key). Every mutating action is approval-gated.',
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    authentication: { schemes: ['none'] },
  };
}

/** Lifecycle states for an A2A task. */
export type A2ATaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  /** The inbound message that created the task. */
  message: A2AMessage;
  /** Result artifact produced on completion (opaque to the transport). */
  artifact?: unknown;
  /** Machine-readable failure when status === 'failed'. */
  error?: { code: string; message: string };
  history: Array<{ status: A2ATaskStatus; at: number }>;
  createdAt: number;
  updatedAt: number;
}

export interface A2AMessagePart {
  kind: 'text';
  text: string;
}

export interface A2AMessage {
  messageId: string;
  role: 'user' | 'agent';
  parts: A2AMessagePart[];
}

/** JSON-RPC 2.0 wire shapes. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/**
 * A handler for the `message/send` method: receives the inbound message and
 * the task record (already in 'working' state) and returns the artifact to
 * store on completion. Throwing fails the task.
 */
export type A2AMessageHandler = (message: A2AMessage, task: A2ATask) => Promise<unknown>;

function now(): number {
  return Date.now();
}

function textOf(message: A2AMessage): string {
  return message.parts.map((p) => p.text).join('\n');
}

/**
 * The A2A server: owns task lifecycle, validates JSON-RPC, and dispatches
 * `message/send` to the configured handler. Transport-agnostic — the
 * in-memory transport (or an HTTP route) feeds it JsonRpcRequest objects.
 */
export class A2AServer {
  private readonly tasks = new Map<string, A2ATask>();
  private readonly handler: A2AMessageHandler;
  readonly card: AgentCard;

  constructor(opts: { card: AgentCard; handler?: A2AMessageHandler }) {
    this.card = opts.card;
    this.handler = opts.handler ?? (async (message) => ({ echo: textOf(message) }));
  }

  /** Create a task in 'submitted' state without running it (rarely needed directly). */
  createTask(message: A2AMessage): A2ATask {
    const task: A2ATask = {
      id: `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      status: 'submitted',
      message,
      history: [{ status: 'submitted', at: now() }],
      createdAt: now(),
      updatedAt: now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }

  listTasks(): A2ATask[] {
    return [...this.tasks.values()];
  }

  private transition(task: A2ATask, status: A2ATaskStatus): void {
    task.status = status;
    task.updatedAt = now();
    task.history.push({ status, at: task.updatedAt });
  }

  /**
   * Run a submitted task through working → completed/failed. The transition
   * to 'working' is recorded BEFORE the handler runs so observers (and
   * tasks/get polling) see the honest intermediate state.
   */
  async runTask(task: A2ATask): Promise<A2ATask> {
    if (task.status !== 'submitted') {
      throw new Error(`cannot run task in status "${task.status}"`);
    }
    this.transition(task, 'working');
    try {
      task.artifact = await this.handler(task.message, task);
      this.transition(task, 'completed');
    } catch (err) {
      task.error = {
        code: 'handler_failed',
        message: err instanceof Error ? err.message : String(err),
      };
      this.transition(task, 'failed');
    }
    return task;
  }

  cancelTask(id: string): A2ATask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`unknown task "${id}"`);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
      throw new Error(`task "${id}" is already terminal (${task.status})`);
    }
    this.transition(task, 'canceled');
    return task;
  }

  /** Serialize a task for the wire (drops nothing the client needs). */
  static toWire(task: A2ATask): Record<string, unknown> {
    return {
      id: task.id,
      status: { state: task.status },
      history: task.history,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.artifact !== undefined ? { artifacts: [{ parts: [{ kind: 'text', text: JSON.stringify(task.artifact) }] }] } : {}),
      ...(task.error ? { error: task.error } : {}),
    };
  }

  /**
   * Handle one JSON-RPC 2.0 request. Supported methods:
   * - message/send { message } → runs the task synchronously and returns the completed/failed task
   * - tasks/get { id } → the task
   * - tasks/cancel { id } → cancels a non-terminal task
   */
  async handleJsonRpc(raw: unknown): Promise<JsonRpcResponse> {
    const req = raw as Partial<JsonRpcRequest> | null;
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string' || req.id === undefined || req.id === null) {
      return { jsonrpc: '2.0', id: (req as { id?: string | number } | null)?.id ?? null, error: { code: JSON_RPC_ERRORS.invalidRequest, message: 'Invalid Request: need { jsonrpc: "2.0", id, method }' } };
    }
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'message/send': {
          const message = params['message'] as A2AMessage | undefined;
          if (!message || typeof message.messageId !== 'string' || !Array.isArray(message.parts)) {
            throw jsonRpcError(JSON_RPC_ERRORS.invalidParams, 'message/send needs params.message { messageId, role, parts }');
          }
          const task = this.createTask(message);
          await this.runTask(task);
          return { jsonrpc: '2.0', id: req.id, result: A2AServer.toWire(task) };
        }
        case 'tasks/get': {
          const id = params['id'];
          if (typeof id !== 'string') throw jsonRpcError(JSON_RPC_ERRORS.invalidParams, 'tasks/get needs params.id (string)');
          const task = this.getTask(id);
          if (!task) throw jsonRpcError(JSON_RPC_ERRORS.invalidParams, `unknown task "${id}"`);
          return { jsonrpc: '2.0', id: req.id, result: A2AServer.toWire(task) };
        }
        case 'tasks/cancel': {
          const id = params['id'];
          if (typeof id !== 'string') throw jsonRpcError(JSON_RPC_ERRORS.invalidParams, 'tasks/cancel needs params.id (string)');
          return { jsonrpc: '2.0', id: req.id, result: A2AServer.toWire(this.cancelTask(id)) };
        }
        default:
          throw jsonRpcError(JSON_RPC_ERRORS.methodNotFound, `unknown method "${req.method}"`);
      }
    } catch (err) {
      if (isJsonRpcError(err)) {
        return { jsonrpc: '2.0', id: req.id, error: { code: err.code, message: err.message } };
      }
      return { jsonrpc: '2.0', id: req.id, error: { code: JSON_RPC_ERRORS.internalError, message: err instanceof Error ? err.message : String(err) } };
    }
  }
}

class JsonRpcMethodError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
function jsonRpcError(code: number, message: string): JsonRpcMethodError {
  return new JsonRpcMethodError(code, message);
}
function isJsonRpcError(err: unknown): err is JsonRpcMethodError {
  return err instanceof JsonRpcMethodError;
}

/**
 * In-memory transport: delivers JSON-RPC requests to an A2AServer in the
 * same process. The client-side call shape mirrors what an HTTP JSON-RPC
 * client would send, so swapping in a real transport later keeps the
 * protocol logic identical.
 */
export class InMemoryA2ATransport {
  private seq = 0;
  constructor(private readonly server: A2AServer) {}

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = `rpc_${++this.seq}`;
    const res = await this.server.handleJsonRpc({ jsonrpc: '2.0', id, method, params });
    if (res.error) {
      throw new Error(`A2A ${method} failed (${res.error.code}): ${res.error.message}`);
    }
    return res.result;
  }

  /** Raw request passthrough for tests that need to inspect error envelopes. */
  async raw(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return this.server.handleJsonRpc(request);
  }
}

/**
 * Mock remote peer: an A2AServer with a canned skill handler. Tests (and
 * local dev) use it as the "other agent" at the far end of the transport.
 */
export class MockA2APeer extends A2AServer {
  /** Log of every message the peer received, in order. */
  readonly received: A2AMessage[] = [];

  constructor(card?: Partial<AgentCard>) {
    super({
      card: { ...defaultAgentCard('mock://peer'), name: 'Mock Peer Agent', ...card },
      handler: async (message) => {
        this.received.push(message);
        const text = textOf(message);
        if (/fail/i.test(text)) throw new Error('peer simulated failure');
        return { reply: `peer processed: ${text}`, parts: message.parts.length };
      },
    });
  }

  transport(): InMemoryA2ATransport {
    return new InMemoryA2ATransport(this);
  }
}

/** Build a client-side A2AMessage from plain text. */
export function textMessage(text: string, role: 'user' | 'agent' = 'user'): A2AMessage {
  return { messageId: `msg_${randomUUID().replace(/-/g, '').slice(0, 12)}`, role, parts: [{ kind: 'text', text }] };
}

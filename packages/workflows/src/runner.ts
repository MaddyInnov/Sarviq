// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  BotConfig,
  StreamEvent,
  ToolDefinition,
} from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { WorkflowStore } from './store.js';
import { renderTemplate, type TemplateContext } from './template.js';
import type {
  NodeState,
  NodeStatus,
  RunStatus,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
} from './types.js';

export interface WorkflowRunnerOptions {
  dbPath: string;
  agentRuntime: AgentRuntime;
  governance: GovernanceGateway;
  tools: Map<string, ToolDefinition>;
  bots: Map<string, BotConfig>;
}

export type RunUpdateCallback = (run: WorkflowRun) => void;

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Minimal durable DAG workflow runner.
 *
 * Workflows are validated DAGs with exactly one trigger node. Runs execute
 * level-by-level in topological order: nodes in the same level (fan-out)
 * run concurrently, and a level only starts once every node in the previous
 * level has completed (join = wait for all incoming edges).
 *
 * Every node-state transition and run-status change is persisted to SQLite
 * and broadcast to `onRunUpdate` subscribers (the API layer uses this for SSE).
 */
export class WorkflowRunner {
  private store: WorkflowStore;
  private agentRuntime: AgentRuntime;
  private governance: GovernanceGateway;
  private tools: Map<string, ToolDefinition>;
  private bots: Map<string, BotConfig>;
  private listeners = new Set<RunUpdateCallback>();
  private executing = new Set<string>();

  constructor(opts: WorkflowRunnerOptions) {
    this.store = new WorkflowStore(opts.dbPath);
    this.agentRuntime = opts.agentRuntime;
    this.governance = opts.governance;
    this.tools = opts.tools;
    this.bots = opts.bots;
  }

  close(): void {
    this.store.close();
  }

  // -- definitions ----------------------------------------------------------

  register(def: WorkflowDefinition): void {
    this.validateDefinition(def);
    this.store.saveWorkflow(def);
  }

  listWorkflows(): WorkflowDefinition[] {
    return this.store.listWorkflows();
  }

  getWorkflow(id: string): WorkflowDefinition {
    const def = this.store.getWorkflow(id);
    if (!def) throw new Error(`unknown workflow: ${id}`);
    return def;
  }

  private validateDefinition(def: WorkflowDefinition): void {
    if (!def.id) throw new Error('workflow must have an id');
    const ids = new Set<string>();
    for (const node of def.nodes) {
      if (!node.id) throw new Error('workflow node must have an id');
      if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
      ids.add(node.id);
    }
    for (const [from, to] of def.edges) {
      if (!ids.has(from)) throw new Error(`edge references unknown node: ${from}`);
      if (!ids.has(to)) throw new Error(`edge references unknown node: ${to}`);
    }
    const triggers = def.nodes.filter((n) => n.type === 'trigger');
    if (triggers.length !== 1) {
      throw new Error(`workflow must have exactly one trigger node, found ${triggers.length}`);
    }
    // Cycle detection: Kahn's algorithm over the full graph.
    const indegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const node of def.nodes) {
      indegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }
    for (const [from, to] of def.edges) {
      adjacency.get(from)!.push(to);
      indegree.set(to, indegree.get(to)! + 1);
    }
    const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.pop()!;
      visited += 1;
      for (const next of adjacency.get(id)!) {
        indegree.set(next, indegree.get(next)! - 1);
        if (indegree.get(next) === 0) queue.push(next);
      }
    }
    if (visited !== def.nodes.length) {
      throw new Error('workflow contains a cycle and is not a DAG');
    }
  }

  // -- runs -----------------------------------------------------------------

  /**
   * Create a run and start executing it asynchronously. Resolves with the
   * freshly created run snapshot; execution continues in the background.
   * When `idempotencyKey` is provided and a run already exists for it, the
   * existing run is returned without re-executing anything.
   */
  async startRun(
    workflowId: string,
    input: unknown,
    opts?: { idempotencyKey?: string },
  ): Promise<WorkflowRun> {
    const def = this.getWorkflow(workflowId);
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.store.getRunByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
    }

    const now = Date.now();
    const nodeStates: WorkflowRun['nodeStates'] = {};
    const reachable = this.reachableFromTrigger(def);
    for (const node of def.nodes) {
      nodeStates[node.id] = { status: reachable.has(node.id) ? 'pending' : 'skipped' };
    }
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId,
      status: 'running',
      nodeStates,
      input,
      createdAt: now,
      updatedAt: now,
    };
    if (idempotencyKey) run.idempotencyKey = idempotencyKey;

    try {
      this.store.insertRun(run);
    } catch (err) {
      // Lost a race with a concurrent startRun using the same idempotency key.
      if (idempotencyKey && isUniqueConstraintError(err)) {
        const existing = this.store.getRunByIdempotencyKey(idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }

    // Execute asynchronously without blocking the caller.
    void this.executeRun(run.id).catch((err: unknown) => {
      // executeNode already captures node failures; this is a last-resort guard
      // so an unexpected runner bug still marks the run failed instead of hanging.
      try {
        this.setRunStatus(run.id, 'failed');
      } catch {
        // store may be closed; nothing more we can do
      }
      console.error(`workflow run ${run.id} crashed:`, err);
    });

    return this.getRunOrThrow(run.id);
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.store.getRun(id);
  }

  /** Newest first. */
  listRuns(workflowId?: string): WorkflowRun[] {
    return this.store.listRuns(workflowId);
  }

  /**
   * Resolve once the run reaches a terminal status (succeeded/failed).
   * Rejects on timeout (default 120s) so callers never hang forever.
   */
  awaitRun(id: string, timeoutMs = 120_000): Promise<WorkflowRun> {
    const current = this.store.getRun(id);
    if (!current) return Promise.reject(new Error(`unknown run: ${id}`));
    if (TERMINAL_STATUSES.has(current.status)) return Promise.resolve(current);

    return new Promise<WorkflowRun>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out waiting for run ${id} after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsubscribe = this.onRunUpdate((run) => {
        if (run.id !== id) return;
        if (TERMINAL_STATUSES.has(run.status)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(run);
        }
      });
      // Re-check in case the run finished between the first check and subscribing.
      const rechecked = this.store.getRun(id);
      if (rechecked && TERMINAL_STATUSES.has(rechecked.status)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(rechecked);
      }
    });
  }

  /**
   * Subscribe to run updates. The callback fires after every node-state
   * transition and every run-status change. Returns an unsubscribe function.
   */
  onRunUpdate(cb: RunUpdateCallback): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // -- execution -------------------------------------------------------------

  private async executeRun(runId: string): Promise<void> {
    if (this.executing.has(runId)) return;
    this.executing.add(runId);
    try {
      const run = this.getRunOrThrow(runId);
      const def = this.getWorkflow(run.workflowId);
      const levels = this.topologicalLevels(def);

      for (const level of levels) {
        const current = this.getRunOrThrow(runId);
        if (current.status !== 'running') return; // failed or paused-by-await
        await Promise.all(level.map((nodeId) => this.executeNode(runId, nodeId)));

        const after = this.getRunOrThrow(runId);
        const states = level.map((nodeId) => after.nodeStates[nodeId]?.status);
        if (states.some((s) => s === 'failed')) {
          this.setRunStatus(runId, 'failed');
          return;
        }
        if (states.some((s) => s === 'paused')) {
          // A node is awaiting a governance decision; the run stays paused
          // until the decision arrives and that node completes.
          return;
        }
      }
      this.setRunStatus(runId, 'succeeded');
    } finally {
      this.executing.delete(runId);
    }
  }

  private async executeNode(runId: string, nodeId: string): Promise<void> {
    const run = this.getRunOrThrow(runId);
    const def = this.getWorkflow(run.workflowId);
    const node = def.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`unknown node ${nodeId} in workflow ${def.id}`);

    this.updateNodeState(runId, nodeId, { status: 'running', startedAt: Date.now() });
    try {
      const output = await this.runNodeLogic(runId, node);
      this.updateNodeState(runId, nodeId, { status: 'succeeded', output, endedAt: Date.now() });
      // A node that paused for approval resumes the run once its decision lands.
      const current = this.getRunOrThrow(runId);
      if (current.status === 'paused') this.setRunStatus(runId, 'running');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateNodeState(runId, nodeId, {
        status: 'failed',
        error: message,
        endedAt: Date.now(),
      });
    }
  }

  private async runNodeLogic(runId: string, node: WorkflowNode): Promise<unknown> {
    const run = this.getRunOrThrow(runId);
    const ctx = this.buildTemplateContext(run);

    switch (node.type) {
      case 'trigger':
        return run.input;

      case 'agent': {
        const config = asRecord(node.config);
        const botId = config['botId'];
        if (typeof botId !== 'string' || botId.length === 0) {
          throw new Error(`agent node ${node.id}: config.botId is required`);
        }
        if (!this.bots.has(botId)) throw new Error(`agent node ${node.id}: unknown bot ${botId}`);
        const bot = this.bots.get(botId)!;
        const rendered = renderTemplate(config['prompt'] ?? '', ctx);
        const message = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
        let text = '';
        await this.agentRuntime.runTurn({
          bot,
          message,
          sessionId: `workflow:${runId}:${node.id}`,
          onEvent: (event: StreamEvent) => {
            if (event.type === 'token') text += event.content;
          },
        });
        return text;
      }

      case 'tool': {
        const config = asRecord(node.config);
        const toolName = config['tool'];
        if (typeof toolName !== 'string' || toolName.length === 0) {
          throw new Error(`tool node ${node.id}: config.tool is required`);
        }
        const tool = this.tools.get(toolName);
        if (!tool) throw new Error(`tool node ${node.id}: unknown tool ${toolName}`);
        const args = asRecord(renderTemplate(config['args'] ?? {}, ctx));
        const toolCtx = { sessionId: `workflow:${runId}`, botId: 'workflow' };

        const evaluation = await this.governance.evaluate(toolName, args, {
          ...toolCtx,
          actor: 'workflow-runner',
        });
        if (evaluation.effect === 'deny') {
          throw new Error('tool call denied by policy');
        }
        if (evaluation.effect === 'require-approval' && evaluation.approvalId) {
          const approved = await this.pauseOnApproval(runId, node.id, evaluation.approvalId);
          if (!approved) throw new Error('denied by user');
        }
        return await tool.handler(args, toolCtx);
      }

      case 'http': {
        const config = asRecord(node.config);
        const renderedUrl = renderTemplate(config['url'], ctx);
        if (typeof renderedUrl !== 'string' || renderedUrl.length === 0) {
          throw new Error(`http node ${node.id}: config.url is required`);
        }
        const method = typeof config['method'] === 'string' ? config['method'].toUpperCase() : 'GET';
        const headers = asRecord(renderTemplate(config['headers'] ?? {}, ctx)) as Record<string, string>;
        let bodyInit: string | undefined;
        if (config['body'] !== undefined) {
          const renderedBody = renderTemplate(config['body'], ctx);
          if (typeof renderedBody === 'string') {
            bodyInit = renderedBody;
          } else {
            bodyInit = JSON.stringify(renderedBody);
            if (!headers['content-type'] && !headers['Content-Type']) {
              headers['content-type'] = 'application/json';
            }
          }
        }
        const response = await fetch(renderedUrl, { method, headers, body: bodyInit });
        const text = (await response.text()).slice(0, 20_000);
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
        return { status: response.status, body };
      }

      case 'delay': {
        const config = asRecord(node.config);
        const seconds = Number(config['seconds']);
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`delay node ${node.id}: config.seconds must be a non-negative number`);
        }
        await sleep(seconds * 1000);
        return { waitedSeconds: seconds };
      }

      case 'approval': {
        const config = asRecord(node.config);
        const rendered = renderTemplate(config['message'] ?? '', ctx);
        const message = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
        const approvalId = this.governance.requestApproval(
          'workflow-approval',
          { message, runId, nodeId: node.id },
          { sessionId: `workflow:${runId}`, botId: 'workflow', actor: 'workflow-runner' },
        );
        const approved = await this.pauseOnApproval(runId, node.id, approvalId);
        if (!approved) throw new Error('denied by user');
        return { approved: true };
      }

      default:
        throw new Error(`unsupported node type: ${(node as WorkflowNode).type}`);
    }
  }

  /**
   * Mark node+run paused on an existing approval and wait for the human
   * decision. Returns true when approved.
   */
  private async pauseOnApproval(
    runId: string,
    nodeId: string,
    approvalId: string,
  ): Promise<boolean> {
    this.updateNodeState(runId, nodeId, { status: 'paused', approvalId });
    this.setRunStatus(runId, 'paused');
    const decision = await this.governance.awaitDecision(approvalId);
    return decision === 'approved';
  }

  // -- graph helpers ---------------------------------------------------------

  private reachableFromTrigger(def: WorkflowDefinition): Set<string> {
    const adjacency = new Map<string, string[]>();
    for (const node of def.nodes) adjacency.set(node.id, []);
    for (const [from, to] of def.edges) adjacency.get(from)!.push(to);
    const trigger = def.nodes.find((n) => n.type === 'trigger')!;
    const seen = new Set<string>();
    const stack = [trigger.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of adjacency.get(id)!) stack.push(next);
    }
    return seen;
  }

  /**
   * Level-by-level topological order of the trigger-reachable subgraph.
   * Nodes in the same level have no dependencies on each other (fan-out);
   * every level waits for all previous levels (join).
   */
  private topologicalLevels(def: WorkflowDefinition): string[][] {
    const reachable = this.reachableFromTrigger(def);
    const adjacency = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const id of reachable) {
      adjacency.set(id, []);
      indegree.set(id, 0);
    }
    for (const [from, to] of def.edges) {
      if (!reachable.has(from) || !reachable.has(to)) continue;
      adjacency.get(from)!.push(to);
      indegree.set(to, indegree.get(to)! + 1);
    }
    const levels: string[][] = [];
    let frontier = [...reachable].filter((id) => indegree.get(id) === 0);
    const emitted = new Set<string>();
    while (frontier.length > 0) {
      levels.push(frontier);
      for (const id of frontier) emitted.add(id);
      const next: string[] = [];
      for (const id of frontier) {
        for (const dep of adjacency.get(id)!) {
          indegree.set(dep, indegree.get(dep)! - 1);
          if (indegree.get(dep) === 0) next.push(dep);
        }
      }
      frontier = next;
    }
    if (emitted.size !== reachable.size) {
      throw new Error('workflow graph has a cycle in the trigger-reachable subgraph');
    }
    return levels;
  }

  // -- state helpers ----------------------------------------------------------

  private getRunOrThrow(id: string): WorkflowRun {
    const run = this.store.getRun(id);
    if (!run) throw new Error(`unknown run: ${id}`);
    return run;
  }

  private buildTemplateContext(run: WorkflowRun): TemplateContext {
    const nodes: Record<string, unknown> = {};
    for (const [id, state] of Object.entries(run.nodeStates)) {
      nodes[id] = state.output;
    }
    return { input: run.input, nodes };
  }

  private updateNodeState(runId: string, nodeId: string, patch: Partial<NodeState> & { status: NodeStatus }): void {
    const run = this.getRunOrThrow(runId);
    const current = run.nodeStates[nodeId] ?? { status: 'pending' as NodeStatus };
    const next: NodeState = { ...current, ...patch };
    this.store.upsertNodeState(runId, nodeId, next);
    this.emitUpdate(runId);
  }

  private setRunStatus(runId: string, status: RunStatus): void {
    this.store.updateRunStatus(runId, status, Date.now());
    this.emitUpdate(runId);
  }

  private emitUpdate(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    for (const cb of this.listeners) {
      try {
        cb(run);
      } catch (err) {
        console.error('onRunUpdate listener threw:', err);
      }
    }
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (/UNIQUE constraint failed/i.test(err.message) || (err as { code?: string }).code === 'ERR_SQLITE_CONSTRAINT_UNIQUE')
  );
}

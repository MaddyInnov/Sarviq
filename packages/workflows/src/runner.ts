// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  BotConfig,
  StreamEvent,
  TelemetryCollector,
  ToolDefinition,
} from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';
import { WorkflowStore } from './store.js';
import { renderTemplate, type TemplateContext } from './template.js';
import { evaluateCode, evaluateCondition, type CodeSandboxContext } from './code-sandbox.js';
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
  /**
   * Runtime telemetry collector ("eyes for your AI"). When set, each
   * workflow run gets a telemetry record keyed by runId (a paused run
   * keeps its record open across the approval wait; resume reuses it),
   * with one timed step per node. Metadata-tier fields only.
   */
  telemetry?: TelemetryCollector;
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
  /**
   * In-memory run cache for the duration of executeRun(). The runner is the
   * sole writer of a run while it executes (guarded by `executing`), so
   * caching the assembled run eliminates ~7 redundant DB round trips per
   * node (each getRun = 2 queries: runs + node_states). All mutations write
   * through to the store immediately — the DB stays the durable source of
   * truth for crash-resume and the API still reads from the store directly.
   */
  private runCache = new Map<string, WorkflowRun>();

  /**
   * Telemetry run ids for workflow runs currently executing (runId →
   * telemetry run id). Kept so executeNode can attach node steps to the
   * right record without changing its signature chain.
   */
  private readonly telemetryRuns = new Map<string, string>();
  private readonly telemetry?: TelemetryCollector;

  constructor(opts: WorkflowRunnerOptions) {
    this.store = new WorkflowStore(opts.dbPath);
    this.agentRuntime = opts.agentRuntime;
    this.governance = opts.governance;
    this.tools = opts.tools;
    this.bots = opts.bots;
    this.telemetry = opts.telemetry;
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

  /**
   * Version history of a workflow definition (oldest first). Every
   * register() that changes the definition archives the previous one.
   */
  listWorkflowVersions(id: string): { version: number; savedAt: number }[] {
    this.getWorkflow(id); // throws on unknown workflow
    return this.store.listWorkflowVersions(id);
  }

  /** A previously archived definition version. */
  getWorkflowVersion(id: string, version: number): WorkflowDefinition {
    this.getWorkflow(id); // throws on unknown workflow
    const def = this.store.getWorkflowVersion(id, version);
    if (!def) throw new Error(`unknown version ${version} of workflow: ${id}`);
    return def;
  }

  private validateDefinition(def: WorkflowDefinition): void {
    if (!def.id) throw new Error('workflow must have an id');
    const ids = new Set<string>();
    const byId = new Map<string, WorkflowNode>();
    for (const node of def.nodes) {
      if (!node.id) throw new Error('workflow node must have an id');
      if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
      ids.add(node.id);
      byId.set(node.id, node);
      this.validateNodeConfig(node);
    }
    for (const edge of def.edges) {
      const [from, to, branch] = edge;
      if (!ids.has(from)) throw new Error(`edge references unknown node: ${from}`);
      if (!ids.has(to)) throw new Error(`edge references unknown node: ${to}`);
      if (branch !== undefined) {
        if (branch !== 'true' && branch !== 'false') {
          throw new Error(`edge ${from} → ${to} has invalid branch label: ${String(branch)}`);
        }
        if (byId.get(from)?.type !== 'if') {
          throw new Error(
            `edge ${from} → ${to} carries a branch label but "${from}" is not an 'if' node`,
          );
        }
      }
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

  /**
   * Builder-time config checks for node types with required config shapes.
   * (agent/tool/http checks stay at run time, matching previous behavior.)
   */
  private validateNodeConfig(node: WorkflowNode): void {
    const config = asRecord(node.config);
    if (node.type === 'if') {
      const condition = config['condition'];
      if (typeof condition !== 'string' || condition.trim().length === 0) {
        throw new Error(`if node ${node.id}: config.condition must be a non-empty string`);
      }
    }
    if (node.type === 'set') {
      const assignments = config['assignments'];
      if (assignments !== undefined && (assignments === null || typeof assignments !== 'object' || Array.isArray(assignments))) {
        throw new Error(`set node ${node.id}: config.assignments must be an object`);
      }
    }
    if (node.type === 'code') {
      const code = config['code'];
      if (typeof code !== 'string' || code.trim().length === 0) {
        throw new Error(`code node ${node.id}: config.code must be a non-empty string`);
      }
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

  /** Look up a run by the idempotency key it was started with, if any. */
  getRunByIdempotencyKey(key: string): WorkflowRun | undefined {
    return this.store.getRunByIdempotencyKey(key);
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
   * Crash recovery: find runs stuck in 'running' (the process died without
   * marking them terminal) and resume each from its last checkpoint.
   * Completed steps are never re-executed — resume skips nodes already
   * 'succeeded' and re-runs only pending/interrupted ones. Runs 'paused' for
   * approval stay paused; terminal runs are untouched. Idempotent: calling
   * recover() twice resumes nothing the second time (runs are either picked
   * up by the in-flight `executing` guard or already terminal).
   *
   * Call this once at boot before starting the scheduler / API.
   */
  async recover(): Promise<string[]> {
    const crashed = this.store.listCrashedRuns();
    const resumed: string[] = [];
    for (const run of crashed) {
      if (this.executing.has(run.id)) continue;
      resumed.push(run.id);
      // Await each resume sequentially: keeps the burst of recovered runs
      // bounded and preserves FIFO order by last update.
      try {
        await this.executeRun(run.id);
      } catch (err) {
        console.error(`workflow run ${run.id} failed during recovery:`, err);
      }
    }
    return resumed;
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
    // Prime the run cache: every getRunOrThrow below hits memory instead of
    // re-assembling the run from SQLite (2 queries per call).
    const primed = this.store.getRun(runId);
    if (primed) this.runCache.set(runId, primed);
    // Runtime telemetry: one record per workflow run, keyed by runId so a
    // paused-then-resumed run reuses its record instead of double-counting.
    // Only metadata-tier fields are recorded; the ingestion guard runs.
    let telRunId: string | null = null;
    try {
      telRunId =
        this.telemetry?.beginRun({
          id: runId,
          kind: 'workflow-run',
          workflowId: primed?.workflowId,
          sessionId: runId,
        }) ?? null;
      if (telRunId) this.telemetryRuns.set(runId, telRunId);
    } catch {
      telRunId = null;
    }
    try {
      const run = this.getRunOrThrow(runId);
      const def = this.getWorkflow(run.workflowId);
      const levels = this.topologicalLevels(def);

      for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
        const current = this.getRunOrThrow(runId);
        if (current.status !== 'running') return; // failed or paused-by-await
        // Branch gating: an 'if' node deactivates the untaken branch. A node
        // whose incoming edges are ALL inactive (untaken 'if' branch, or a
        // skipped/failed predecessor) is marked 'skipped' instead of running.
        // The skip propagates level by level, so whole subtrees drop out.
        for (const nodeId of levels[levelIndex]) {
          const s = current.nodeStates[nodeId]?.status;
          if (s === 'pending' && !this.hasActiveIncomingEdge(def, current, nodeId)) {
            this.updateNodeState(runId, nodeId, { status: 'skipped' });
          }
        }
        // Crash-resume: never re-execute steps that already completed (or
        // were skipped as unreachable). Only pending / interrupted nodes run.
        const pending = levels[levelIndex].filter((nodeId) => {
          const s = current.nodeStates[nodeId]?.status;
          return s !== 'succeeded' && s !== 'skipped';
        });
        if (pending.length > 0) {
          await Promise.all(pending.map((nodeId) => this.executeNode(runId, nodeId)));
        }

        const after = this.getRunOrThrow(runId);
        const states = levels[levelIndex].map((nodeId) => after.nodeStates[nodeId]?.status);
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
      // Telemetry: close the run record on terminal status only. A run
      // paused for approval keeps its record open across the wait; the
      // resume path reuses it via the id-keyed beginRun above.
      try {
        const final = this.store.getRun(runId)?.status;
        if (telRunId && (final === 'succeeded' || final === 'failed')) {
          this.telemetry?.endRun(telRunId, { status: final === 'succeeded' ? 'ok' : 'error' });
          this.telemetryRuns.delete(runId);
        }
      } catch {
        // Telemetry must never break execution.
      }
      this.runCache.delete(runId);
      this.executing.delete(runId);
    }
  }

  private async executeNode(runId: string, nodeId: string): Promise<void> {
    const run = this.getRunOrThrow(runId);
    const def = this.getWorkflow(run.workflowId);
    const node = def.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`unknown node ${nodeId} in workflow ${def.id}`);

    // Telemetry: one timed step per node (latency + ok/error).
    const telRunId = this.telemetryRuns.get(runId) ?? null;
    const nodeStep = telRunId ? this.telemetry?.startStep(telRunId, node.id, 'node') : null;

    // Attempt counting for run-health retry heuristics: re-execution of an
    // already-attempted node (crash-resume, manual re-run) increments.
    const priorAttempts = run.nodeStates[nodeId]?.attempts ?? 0;
    this.updateNodeState(runId, nodeId, {
      status: 'running',
      startedAt: Date.now(),
      attempts: priorAttempts + 1,
    });
    try {
      const output = await this.runNodeLogic(runId, node);
      this.updateNodeState(runId, nodeId, { status: 'succeeded', output, endedAt: Date.now() });
      this.checkpoint(runId);
      nodeStep?.end({ ok: true });
      // A node that paused for approval resumes the run once its decision lands.
      const current = this.getRunOrThrow(runId);
      if (current.status === 'paused') this.setRunStatus(runId, 'running');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      nodeStep?.end({ ok: false, errorKind: err instanceof Error ? err.name : 'Error' });
      this.updateNodeState(runId, nodeId, {
        status: 'failed',
        error: message,
        endedAt: Date.now(),
      });
      this.checkpoint(runId);
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

      case 'if': {
        const config = asRecord(node.config);
        const rawCondition = config['condition'];
        if (typeof rawCondition !== 'string' || rawCondition.trim().length === 0) {
          throw new Error(`if node ${node.id}: config.condition must be a non-empty string`);
        }
        const rendered = renderTemplate(rawCondition, ctx);
        const sandboxCtx = this.buildCodeSandboxContext(run);
        const condition = await this.evaluateConditionValue(node.id, rendered, sandboxCtx);
        return { condition };
      }

      case 'set': {
        const config = asRecord(node.config);
        const assignments = asRecord(config['assignments'] ?? {});
        const output: Record<string, unknown> = {};
        if (config['includeInput'] === true) {
          Object.assign(output, asRecord(run.input));
        }
        for (const [field, template] of Object.entries(assignments)) {
          output[field] = renderTemplate(template, ctx);
        }
        return output;
      }

      case 'code': {
        const config = asRecord(node.config);
        const code = config['code'];
        if (typeof code !== 'string' || code.trim().length === 0) {
          throw new Error(`code node ${node.id}: config.code must be a non-empty string`);
        }
        const timeoutMs =
          typeof config['timeoutMs'] === 'number' ? config['timeoutMs'] : undefined;
        try {
          return await evaluateCode(code, this.buildCodeSandboxContext(run), timeoutMs);
        } catch (err) {
          throw new Error(
            `code node ${node.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      case 'bot-turn': {
        // Workflow → bot: run a bot turn as a node and store the output.
        // Unlike the 'agent' node (which always runs in an isolated
        // per-node session and returns raw text), 'bot-turn' supports
        // thread continuity: pass config.sessionId to continue an existing
        // conversation thread, and the output carries the sessionId so
        // later nodes can chain onto the same thread.
        const config = asRecord(node.config);
        const botId = config['botId'];
        if (typeof botId !== 'string' || botId.length === 0) {
          throw new Error(`bot-turn node ${node.id}: config.botId is required`);
        }
        const bot = this.bots.get(botId);
        if (!bot) throw new Error(`bot-turn node ${node.id}: unknown bot ${botId}`);
        const rendered = renderTemplate(config['prompt'] ?? '', ctx);
        const message = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
        const renderedSession = renderTemplate(config['sessionId'] ?? '', ctx);
        const sessionId =
          typeof renderedSession === 'string' && renderedSession.length > 0
            ? renderedSession
            : `workflow:${runId}:${node.id}`;
        let text = '';
        await this.agentRuntime.runTurn({
          bot,
          message,
          sessionId,
          onEvent: (event: StreamEvent) => {
            if (event.type === 'token') text += event.content;
          },
        });
        return { text, sessionId };
      }

      default:
        throw new Error(`unsupported node type: ${(node as WorkflowNode).type}`);
    }
  }

  /**
   * Resolve an 'if' condition to a boolean. Templates render first; a plain
   * boolean/number result is used directly, the strings "true"/"false"
   * parse literally, and anything else is evaluated as a JS expression in
   * the code sandbox (e.g. "{{nodes.a.output.n}} > 5" renders to "3 > 5").
   */
  private async evaluateConditionValue(
    nodeId: string,
    rendered: unknown,
    sandboxCtx: CodeSandboxContext,
  ): Promise<boolean> {
    if (typeof rendered === 'boolean') return rendered;
    if (typeof rendered === 'number') return rendered !== 0;
    if (typeof rendered === 'string') {
      const trimmed = rendered.trim();
      const lowered = trimmed.toLowerCase();
      if (lowered === 'true') return true;
      if (lowered === 'false' || lowered === '') return false;
      try {
        return await evaluateCondition(trimmed, sandboxCtx);
      } catch (err) {
        throw new Error(
          `if node ${nodeId}: condition expression failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return Boolean(rendered);
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
    this.checkpoint(runId);
    const decision = await this.governance.awaitDecision(approvalId);
    return decision === 'approved';
  }

  // -- graph helpers ---------------------------------------------------------

  /**
   * True when at least one incoming edge of `nodeId` is currently carrying:
   * the source node succeeded, and — for a labeled edge out of an 'if' node —
   * the label matches the branch the 'if' took. Nodes with no incoming edges
   * (the trigger) always carry.
   */
  private hasActiveIncomingEdge(def: WorkflowDefinition, run: WorkflowRun, nodeId: string): boolean {
    const incoming = def.edges.filter((edge) => edge[1] === nodeId);
    if (incoming.length === 0) return true;
    return incoming.some((edge) => {
      const [from, , branch] = edge;
      const srcState = run.nodeStates[from];
      if (!srcState || srcState.status !== 'succeeded') return false;
      if (branch === undefined) return true;
      const srcNode = def.nodes.find((n) => n.id === from);
      if (srcNode?.type !== 'if') return true; // validated; defensive
      return this.branchTaken(srcState) === (branch === 'true');
    });
  }

  /** Which branch an executed 'if' node took. Defaults to false when unknown. */
  private branchTaken(ifState: NodeState): boolean {
    const output = ifState.output;
    return (
      typeof output === 'object' &&
      output !== null &&
      (output as { condition?: unknown }).condition === true
    );
  }

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
    const cached = this.runCache.get(id);
    if (cached) return cached;
    const run = this.store.getRun(id);
    if (!run) throw new Error(`unknown run: ${id}`);
    return run;
  }

  /**
   * Context for the code sandbox: `input` is the run input and
   * `nodes.<id>.output` is that node's output — mirroring the template
   * reference syntax (`{{nodes.<id>.output…}}`) so the same paths work in
   * both places.
   */
  private buildCodeSandboxContext(run: WorkflowRun): CodeSandboxContext {
    const nodes: Record<string, unknown> = {};
    for (const [id, state] of Object.entries(run.nodeStates)) {
      nodes[id] = { output: state.output };
    }
    return { input: run.input, nodes };
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
    // Write-through: keep the cached run in sync so later reads in this
    // execution don't re-assemble from SQLite.
    const cached = this.runCache.get(runId);
    if (cached) cached.nodeStates[nodeId] = next;
    this.emitUpdate(runId);
  }

  private setRunStatus(runId: string, status: RunStatus): void {
    const now = Date.now();
    this.store.updateRunStatus(runId, status, now);
    const cached = this.runCache.get(runId);
    if (cached) {
      cached.status = status;
      cached.updatedAt = now;
    }
    this.emitUpdate(runId);
  }

  /**
   * Write the crash-resume checkpoint for a run: number of completed steps
   * and every completed step's output. Called after each node finishes (and
   * on pause) so a crash always resumes from the latest durable state.
   */
  private checkpoint(runId: string): void {
    const run = this.getRunOrThrow(runId);
    const stepOutputs: Record<string, unknown> = {};
    let completed = 0;
    for (const [nodeId, state] of Object.entries(run.nodeStates)) {
      if (state.status === 'succeeded') {
        completed += 1;
        stepOutputs[nodeId] = state.output;
      }
    }
    this.store.checkpointRun(runId, { currentStepIndex: completed, stepOutputs }, Date.now());
  }

  private emitUpdate(runId: string): void {
    const run = this.runCache.get(runId) ?? this.store.getRun(runId);
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

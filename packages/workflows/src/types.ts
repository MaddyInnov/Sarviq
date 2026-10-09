// SPDX-License-Identifier: Apache-2.0

/** Node types supported by the MVP workflow runner. */
export type NodeType =
  | 'trigger'
  | 'agent'
  | 'tool'
  | 'http'
  | 'delay'
  | 'approval'
  | 'if'
  | 'set'
  | 'code'
  | 'bot-turn';

/**
 * Branch label on an edge leaving an 'if' node: which condition outcome the
 * edge carries ('true' → condition held, 'false' → it did not). Unlabeled
 * edges always carry.
 */
export type EdgeBranch = 'true' | 'false';

/**
 * A directed edge, optionally carrying a branch label for 'if'-node outputs.
 * Plain 2-tuples keep working everywhere: `[from, to]` ≡ `[from, to]` with
 * no label.
 */
export type WorkflowEdge = [string, string] | [string, string, EdgeBranch];

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
}

/**
 * Config shapes for the branch/transform node types (informational — the
 * runner reads these fields; configs are plain JSON).
 */
export interface IfNodeConfig {
  /**
   * Condition expression. Templates (`{{input}}`, `{{nodes.<id>.output…}}`)
   * are rendered first; the result may be a boolean, or a JS expression
   * string evaluated in the code sandbox (e.g. "{{nodes.a.output.n}} > 5").
   */
  condition: string;
}

export interface SetNodeConfig {
  /** Field → template string (rendered with {{input}} / {{nodes…}}). */
  assignments: Record<string, unknown>;
  /** When true, run input fields are merged underneath the assignments. */
  includeInput?: boolean;
}

export interface CodeNodeConfig {
  /** JS function body; `input` and `nodes` are in scope, `return` → output. */
  code: string;
  /** Wall-clock cap in ms (default 5000, hard cap 30000). */
  timeoutMs?: number;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  /** Edges as [fromId, toId] pairs, with optional 'if'-branch labels. */
  edges: WorkflowEdge[];
}

export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'paused' | 'skipped';

export type RunStatus = 'running' | 'paused' | 'succeeded' | 'failed';

export interface NodeState {
  status: NodeStatus;
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  approvalId?: string;
  /**
   * Execution attempts for this node. 1 on first execution; increments when
   * the node is re-executed (e.g. crash-resume re-runs an interrupted node).
   * Feeds run-health retry heuristics.
   */
  attempts?: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: RunStatus;
  nodeStates: Record<string, NodeState>;
  input: unknown;
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
  /** Crash-resume checkpoint: index of the last completed step (level). */
  currentStepIndex?: number;
  /** Crash-resume checkpoint: outputs of completed steps, keyed by node id. */
  stepOutputs?: Record<string, unknown>;
}

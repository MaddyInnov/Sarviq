// SPDX-License-Identifier: Apache-2.0

/** Node types supported by the MVP workflow runner. */
export type NodeType = 'trigger' | 'agent' | 'tool' | 'http' | 'delay' | 'approval';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name: string;
  config: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  /** Edges as [fromId, toId] pairs. */
  edges: [string, string][];
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

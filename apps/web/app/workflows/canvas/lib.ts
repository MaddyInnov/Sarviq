// SPDX-License-Identifier: Apache-2.0
// Pure functions for the visual workflow builder at
// apps/web/app/workflows/canvas/page.tsx. No DOM, no React — this module is
// covered by lib.test.ts and is the single source of truth for converting
// between the canvas graph and the workflow JSON format defined in
// @mvp/workflows types.ts (mirrored as WorkflowDefinition in lib/api.ts).
//
// Round-trip contract: workflowToGraph(w) |> graphToWorkflow(g) === w for any
// well-formed WorkflowDefinition (node ids, types, names, configs, and edge
// order are preserved; layout positions x/y are canvas-only metadata).

import type { WorkflowDefinition } from '../../../lib/api';

/** Node types supported by the MVP workflow runner. */
export type CanvasNodeType = 'trigger' | 'agent' | 'tool' | 'http' | 'delay' | 'approval';

export const NODE_TYPES: readonly CanvasNodeType[] = [
  'trigger',
  'agent',
  'tool',
  'http',
  'delay',
  'approval',
];

/** Placeholder config per node type, matching what the runner reads. */
export const DEFAULT_NODE_CONFIGS: Readonly<Record<CanvasNodeType, Record<string, unknown>>> = {
  trigger: {},
  agent: { botId: '', prompt: '' },
  tool: { tool: '', args: {} },
  http: { url: '', method: 'GET' },
  delay: { seconds: 60 },
  approval: { message: '' },
};

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  name: string;
  config: Record<string, unknown>;
  /** Canvas position, px. Not part of the workflow JSON. */
  x: number;
  y: number;
}

export interface CanvasGraph {
  id: string;
  name: string;
  description?: string;
  nodes: CanvasNode[];
  /** Edges as [fromId, toId] pairs. */
  edges: [string, string][];
}

const COL_GAP = 260;
const ROW_GAP = 110;
const COL_X0 = 40;
const ROW_Y0 = 40;

function isNodeType(t: string): t is CanvasNodeType {
  return (NODE_TYPES as readonly string[]).includes(t);
}

/** Strip canvas metadata → the workflow JSON the runner consumes. */
export function graphToWorkflow(graph: CanvasGraph): WorkflowDefinition {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges: [string, string][] = [];
  for (const [from, to] of graph.edges) {
    if (!ids.has(from) || !ids.has(to) || from === to) continue; // drop dangling/self edges
    const key = `${from}→${to}`;
    if (seen.has(key)) continue; // drop duplicates
    seen.add(key);
    edges.push([from, to]);
  }
  const def: WorkflowDefinition = {
    id: graph.id,
    name: graph.name,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      config: n.config,
    })),
    edges,
  };
  if (graph.description !== undefined && graph.description.trim()) {
    def.description = graph.description;
  }
  return def;
}

/**
 * Place a workflow on the canvas. Node ids are preserved exactly so edits
 * round-trip. Layout: columns by longest-path depth from source nodes;
 * disconnected/cyclic nodes share column 0.
 */
export function workflowToGraph(wf: WorkflowDefinition): CanvasGraph {
  const ids = new Set(wf.nodes.map((n) => n.id));
  const depth = new Map<string, number>();
  // Longest-path relaxation (Bellman-Ford style); bounded iterations so
  // cycles terminate instead of looping forever.
  for (let i = 0; i < wf.nodes.length + 1; i++) {
    for (const [from, to] of wf.edges) {
      if (!ids.has(from) || !ids.has(to)) continue;
      const d = depth.get(from) ?? 0;
      if ((depth.get(to) ?? -1) < d + 1) depth.set(to, d + 1);
    }
  }
  const perColumn = new Map<number, number>();
  const nodes: CanvasNode[] = wf.nodes.map((n) => {
    const col = depth.get(n.id) ?? 0;
    const row = perColumn.get(col) ?? 0;
    perColumn.set(col, row + 1);
    return {
      id: n.id,
      type: isNodeType(n.type) ? n.type : 'tool',
      name: n.name,
      config: { ...n.config },
      x: COL_X0 + col * COL_GAP,
      y: ROW_Y0 + row * ROW_GAP,
    };
  });
  const graph: CanvasGraph = {
    id: wf.id,
    name: wf.name,
    nodes,
    edges: wf.edges
      .filter(([from, to]) => ids.has(from) && ids.has(to))
      .map(([from, to]) => [from, to] as [string, string]),
  };
  if (wf.description) graph.description = wf.description;
  return graph;
}

/**
 * Validate a graph for builder-time mistakes. Returns a list of human-readable
 * problems; empty means the graph serializes cleanly.
 */
export function validateGraph(graph: CanvasGraph): string[] {
  const problems: string[] = [];
  if (!graph.name.trim()) problems.push('Workflow needs a name.');
  const seenIds = new Set<string>();
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.id.trim()) {
      problems.push('A node has an empty id.');
      continue;
    }
    if (seenIds.has(n.id)) problems.push(`Duplicate node id "${n.id}".`);
    seenIds.add(n.id);
    ids.add(n.id);
    if (!isNodeType(n.type)) problems.push(`Node "${n.id}" has unknown type "${n.type}".`);
    if (!n.name.trim()) problems.push(`Node "${n.id}" has an empty name.`);
    // Runner-required configs (see @mvp/workflows runner.ts).
    const c = n.config ?? {};
    if (n.type === 'agent' && typeof c['botId'] !== 'string') {
      problems.push(`Agent node "${n.id}" needs config.botId (string).`);
    }
    if (n.type === 'tool' && typeof c['tool'] !== 'string') {
      problems.push(`Tool node "${n.id}" needs config.tool (string).`);
    }
    if (n.type === 'http' && typeof c['url'] !== 'string') {
      problems.push(`HTTP node "${n.id}" needs config.url (string).`);
    }
    if (n.type === 'delay') {
      const s = Number(c['seconds']);
      if (!Number.isFinite(s) || s < 0) problems.push(`Delay node "${n.id}" needs config.seconds ≥ 0.`);
    }
  }
  const seenEdges = new Set<string>();
  for (const [from, to] of graph.edges) {
    if (!ids.has(from)) problems.push(`Edge starts at unknown node "${from}".`);
    if (!ids.has(to)) problems.push(`Edge ends at unknown node "${to}".`);
    if (from === to && ids.has(from)) problems.push(`Node "${from}" has a self-edge.`);
    const key = `${from}→${to}`;
    if (seenEdges.has(key)) problems.push(`Duplicate edge ${from} → ${to}.`);
    seenEdges.add(key);
  }
  return problems;
}

/**
 * Suggest a fresh node id that does not collide with existing ids
 * (e.g. "agent", "agent-2", "agent-3", ...).
 */
export function suggestNodeId(type: CanvasNodeType, existing: ReadonlySet<string>): string {
  if (!existing.has(type)) return type;
  let i = 2;
  while (existing.has(`${type}-${i}`)) i++;
  return `${type}-${i}`;
}

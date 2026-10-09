// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../../../lib/api';
import {
  DEFAULT_NODE_CONFIGS,
  NODE_TYPES,
  graphToWorkflow,
  suggestNodeId,
  validateGraph,
  workflowToGraph,
  type CanvasGraph,
} from './lib';

const SEED_LIKE: WorkflowDefinition = {
  id: 'research-note',
  name: 'Research → Summarize → Save note',
  description: 'Research a topic, get approval, save the note.',
  nodes: [
    { id: 'trigger', type: 'trigger', name: 'Start', config: {} },
    {
      id: 'research',
      type: 'agent',
      name: 'Research topic',
      config: { botId: 'scout', prompt: 'Research: {{input}}' },
    },
    { id: 'review', type: 'approval', name: 'Human review', config: { message: 'ok?' } },
  ],
  edges: [
    ['trigger', 'research'],
    ['research', 'review'],
  ],
};

describe('workflowToGraph', () => {
  it('preserves node ids, types, names, configs and edge order', () => {
    const g = workflowToGraph(SEED_LIKE);
    expect(g.id).toBe('research-note');
    expect(g.name).toBe(SEED_LIKE.name);
    expect(g.description).toBe(SEED_LIKE.description);
    expect(g.nodes.map((n) => n.id)).toEqual(['trigger', 'research', 'review']);
    expect(g.nodes.map((n) => n.type)).toEqual(['trigger', 'agent', 'approval']);
    expect(g.nodes.map((n) => n.name)).toEqual(['Start', 'Research topic', 'Human review']);
    expect(g.nodes[1].config).toEqual({ botId: 'scout', prompt: 'Research: {{input}}' });
    expect(g.edges).toEqual([
      ['trigger', 'research'],
      ['research', 'review'],
    ]);
  });

  it('lays nodes out in columns by longest-path depth', () => {
    const g = workflowToGraph(SEED_LIKE);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId['trigger'].x).toBeLessThan(byId['research'].x);
    expect(byId['research'].x).toBeLessThan(byId['review'].x);
  });

  it('handles disconnected nodes and cycles without hanging', () => {
    const g = workflowToGraph({
      id: 'weird',
      name: 'weird',
      nodes: [
        { id: 'a', type: 'tool', name: 'a', config: {} },
        { id: 'b', type: 'tool', name: 'b', config: {} },
      ],
      edges: [
        ['a', 'b'],
        ['b', 'a'], // cycle
      ],
    });
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(2);
  });

  it('drops edges that reference missing nodes', () => {
    const g = workflowToGraph({
      id: 'dangling',
      name: 'dangling',
      nodes: [{ id: 'a', type: 'tool', name: 'a', config: {} }],
      edges: [['a', 'ghost']],
    });
    expect(g.edges).toEqual([]);
  });
});

describe('graphToWorkflow', () => {
  it('round-trips a workflow definition exactly', () => {
    const back = graphToWorkflow(workflowToGraph(SEED_LIKE));
    expect(back).toEqual(SEED_LIKE);
  });

  it('drops dangling, self, and duplicate edges', () => {
    const graph: CanvasGraph = {
      id: 'g',
      name: 'g',
      nodes: [
        { id: 'a', type: 'trigger', name: 'a', config: {}, x: 0, y: 0 },
        { id: 'b', type: 'delay', name: 'b', config: { seconds: 5 }, x: 100, y: 0 },
      ],
      edges: [
        ['a', 'b'],
        ['a', 'b'], // duplicate
        ['a', 'a'], // self
        ['a', 'ghost'], // dangling
      ],
    };
    const wf = graphToWorkflow(graph);
    expect(wf.edges).toEqual([['a', 'b']]);
    expect(wf.nodes[0]).toEqual({ id: 'a', type: 'trigger', name: 'a', config: {} });
  });

  it('omits a blank description', () => {
    const wf = graphToWorkflow({ id: 'g', name: 'g', description: '   ', nodes: [], edges: [] });
    expect('description' in wf).toBe(false);
  });
});

describe('validateGraph', () => {
  it('accepts a clean graph', () => {
    expect(validateGraph(workflowToGraph(SEED_LIKE))).toEqual([]);
  });

  it('flags naming, id, edge, and config problems', () => {
    const problems = validateGraph({
      id: 'bad',
      name: '  ',
      nodes: [
        { id: 'a', type: 'agent', name: '', config: {}, x: 0, y: 0 }, // empty name, missing botId
        { id: 'a', type: 'http', name: 'dup', config: { url: 'x' }, x: 0, y: 0 }, // duplicate id
        { id: 'd', type: 'delay', name: 'd', config: { seconds: -3 }, x: 0, y: 0 }, // bad seconds
      ],
      edges: [
        ['a', 'missing'], // unknown target
        ['a', 'a'], // self edge
      ],
    });
    expect(problems.join('\n')).toMatch(/name/);
    expect(problems.join('\n')).toMatch(/Duplicate node id "a"/);
    expect(problems.join('\n')).toMatch(/config\.botId/);
    expect(problems.join('\n')).toMatch(/config\.seconds/);
    expect(problems.join('\n')).toMatch(/unknown node "missing"/);
    expect(problems.join('\n')).toMatch(/self-edge/);
  });
});

describe('helpers', () => {
  it('suggests non-colliding node ids', () => {
    expect(suggestNodeId('agent', new Set())).toBe('agent');
    expect(suggestNodeId('agent', new Set(['agent']))).toBe('agent-2');
    expect(suggestNodeId('agent', new Set(['agent', 'agent-2']))).toBe('agent-3');
  });

  it('covers all nine runner node types with default configs', () => {
    expect(NODE_TYPES).toEqual([
      'trigger',
      'agent',
      'tool',
      'http',
      'delay',
      'approval',
      'if',
      'set',
      'code',
    ]);
    for (const t of NODE_TYPES) {
      expect(typeof DEFAULT_NODE_CONFIGS[t]).toBe('object');
    }
  });

  it('round-trips if-branch edge labels through the workflow JSON', () => {
    const graph: CanvasGraph = {
      id: 'branch',
      name: 'Branch',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'T', config: {}, x: 0, y: 0 },
        { id: 'check', type: 'if', name: 'C', config: { condition: 'true' }, x: 0, y: 0 },
        { id: 'yes', type: 'set', name: 'Y', config: { assignments: {} }, x: 0, y: 0 },
        { id: 'no', type: 'set', name: 'N', config: { assignments: {} }, x: 0, y: 0 },
      ],
      edges: [
        ['trigger', 'check'],
        ['check', 'yes', 'true'],
        ['check', 'no', 'false'],
      ],
    };
    const wf = graphToWorkflow(graph);
    expect(wf.edges).toEqual([
      ['trigger', 'check'],
      ['check', 'yes', 'true'],
      ['check', 'no', 'false'],
    ]);
    const back = workflowToGraph(wf);
    expect(back.edges).toEqual(graph.edges);
    expect(validateGraph(graph)).toEqual([]);
  });

  it('flags branch labels on non-if edges and missing if/set/code configs', () => {
    const problems = validateGraph({
      id: 'bad-branch',
      name: 'Bad',
      nodes: [
        { id: 't', type: 'trigger', name: 'T', config: {}, x: 0, y: 0 },
        { id: 'c', type: 'if', name: 'C', config: {}, x: 0, y: 0 }, // missing condition
        { id: 's', type: 'set', name: 'S', config: { assignments: 'nope' }, x: 0, y: 0 },
        { id: 'k', type: 'code', name: 'K', config: {}, x: 0, y: 0 }, // missing code
      ],
      edges: [
        ['t', 's', 'true'], // label on non-if edge
        ['c', 'k', 'maybe' as 'true'], // invalid label
      ],
    });
    const joined = problems.join('\n');
    expect(joined).toMatch(/config\.condition/);
    expect(joined).toMatch(/config\.assignments/);
    expect(joined).toMatch(/config\.code/);
    expect(joined).toMatch(/not an if node/);
    expect(joined).toMatch(/invalid branch label/);
  });
});

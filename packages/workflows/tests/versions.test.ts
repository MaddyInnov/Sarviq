// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { WorkflowStore } from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

function def(version: string): WorkflowDefinition {
  return {
    id: 'wf-versioned',
    name: 'Versioned',
    nodes: [{ id: 'trigger', type: 'trigger', name: 'T', config: { v: version } }],
    edges: [],
  };
}

describe('workflow definition versioning', () => {
  it('archives the previous definition on every changing save', () => {
    const store = new WorkflowStore(':memory:');
    store.saveWorkflow(def('v1'));
    expect(store.listWorkflowVersions('wf-versioned')).toEqual([]);

    store.saveWorkflow(def('v2'));
    const versions = store.listWorkflowVersions('wf-versioned');
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(typeof versions[0].savedAt).toBe('number');

    const archived = store.getWorkflowVersion('wf-versioned', 1);
    expect(archived?.nodes[0].config).toEqual({ v: 'v1' });
    // Live definition is the newest.
    expect(store.getWorkflow('wf-versioned')?.nodes[0].config).toEqual({ v: 'v2' });

    store.saveWorkflow(def('v3'));
    expect(store.listWorkflowVersions('wf-versioned')).toHaveLength(2);
    expect(store.getWorkflowVersion('wf-versioned', 2)?.nodes[0].config).toEqual({ v: 'v2' });
    store.close();
  });

  it('does not archive when the definition is unchanged', () => {
    const store = new WorkflowStore(':memory:');
    store.saveWorkflow(def('v1'));
    store.saveWorkflow(def('v1'));
    expect(store.listWorkflowVersions('wf-versioned')).toEqual([]);
    store.close();
  });

  it('returns undefined for unknown workflows/versions', () => {
    const store = new WorkflowStore(':memory:');
    expect(store.listWorkflowVersions('nope')).toEqual([]);
    expect(store.getWorkflowVersion('nope', 1)).toBeUndefined();
    store.saveWorkflow(def('v1'));
    expect(store.getWorkflowVersion('wf-versioned', 99)).toBeUndefined();
    store.close();
  });
});

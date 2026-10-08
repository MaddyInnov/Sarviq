// SPDX-License-Identifier: Apache-2.0
'use client';

import { useEffect, useState } from 'react';
import { getRun, getWorkflows } from '../../../lib/api';
import type { WorkflowDefinition, WorkflowRun } from '../../../lib/api';

function fmtTs(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const TERMINAL = new Set(['succeeded', 'failed']);

export default function RunDetail({ runId }: { runId: string }) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [def, setDef] = useState<WorkflowDefinition | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let defLoaded = false;
    const load = async () => {
      try {
        const r = await getRun(runId);
        if (cancelled) return;
        setRun(r);
        setError('');
        if (TERMINAL.has(r.status) && timer) clearInterval(timer);
        if (!defLoaded) {
          defLoaded = true;
          try {
            const defs = await getWorkflows();
            if (!cancelled) setDef(defs.find((d) => d.id === r.workflowId) ?? null);
          } catch {
            // definition lookup is best-effort
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    timer = setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId]);

  if (error) {
    return (
      <div>
        <h1 className="page-title">Run detail</h1>
        <div className="error-box">{error}</div>
      </div>
    );
  }

  if (!run) return <p className="muted">Loading run…</p>;

  const nodeIds = Object.keys(run.nodeStates);
  const statusCls =
    run.status === 'succeeded' ? 'green' : run.status === 'failed' ? 'red' : run.status === 'paused' ? 'amber' : 'blue';

  return (
    <div>
      <h1 className="page-title">
        Run <span className="mono">{run.id.slice(0, 8)}…</span>{' '}
        <span className={`chip ${statusCls}`}>{run.status}</span>
      </h1>
      <p className="page-sub">
        Workflow <span className="mono">{def ? def.name : run.workflowId}</span> · created{' '}
        {fmtTs(run.createdAt)} · updated {fmtTs(run.updatedAt)}
      </p>

      <h3>Nodes</h3>
      <div className="node-chips">
        {nodeIds.map((nodeId) => {
          const st = run.nodeStates[nodeId];
          const nodeDef = def?.nodes.find((n) => n.id === nodeId);
          const cls =
            st.status === 'succeeded'
              ? 'green'
              : st.status === 'failed'
                ? 'red'
                : st.status === 'running'
                  ? 'blue'
                  : st.status === 'paused'
                    ? 'amber'
                    : 'gray';
          return (
            <div key={nodeId} className="node-chip">
              <div className="node-id">{nodeDef ? nodeDef.name : nodeId}</div>
              <div className="node-type mono">{nodeId}</div>
              <div className="mt">
                <span className={`chip ${cls}`}>{st.status}</span>
              </div>
              {st.error && (
                <div className="small" style={{ color: 'var(--red)', marginTop: 6 }}>
                  {st.error}
                </div>
              )}
              {st.approvalId && (
                <div className="small muted" style={{ marginTop: 6 }}>
                  approval <span className="mono">{st.approvalId.slice(0, 8)}…</span>
                </div>
              )}
            </div>
          );
        })}
        {nodeIds.length === 0 && <p className="muted">No node states yet.</p>}
      </div>

      <h3 className="mt">Node outputs</h3>
      {nodeIds.filter((id) => run.nodeStates[id].output !== undefined).length === 0 && (
        <p className="muted">No outputs yet.</p>
      )}
      {nodeIds
        .filter((id) => run.nodeStates[id].output !== undefined)
        .map((id) => (
          <div key={id} className="card">
            <strong className="mono small">{id}</strong>
            <pre className="mono small mt" style={{ maxHeight: 240, overflow: 'auto' }}>
              {prettyJson(run.nodeStates[id].output)}
            </pre>
          </div>
        ))}

      <h3 className="mt">Input</h3>
      <div className="card">
        <pre className="mono small">{prettyJson(run.input)}</pre>
      </div>
    </div>
  );
}

// SPDX-License-Identifier: Apache-2.0
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { getRuns, getWorkflows, runWorkflow } from '../../lib/api';
import type { WorkflowDefinition, WorkflowRun } from '../../lib/api';

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function statusChip(status: WorkflowRun['status']) {
  const cls =
    status === 'succeeded' ? 'green' : status === 'failed' ? 'red' : status === 'paused' ? 'amber' : 'blue';
  return <span className={`chip ${cls}`}>{status}</span>;
}

export default function WorkflowsPage() {
  const router = useRouter();
  const [defs, setDefs] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<string>('');
  // Per-definition run form state.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [idemKeys, setIdemKeys] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([getWorkflows(), getRuns()]);
      setDefs(d);
      setRuns(r);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const start = async (def: WorkflowDefinition) => {
    const rawInput = (inputs[def.id] ?? '').trim();
    let input: unknown;
    if (rawInput) {
      try {
        input = JSON.parse(rawInput) as unknown;
      } catch {
        setError(`Invalid JSON input for workflow "${def.id}"`);
        return;
      }
    }
    const idem = (idemKeys[def.id] ?? '').trim() || undefined;
    setStarting(def.id);
    try {
      const { runId } = await runWorkflow(def.id, input, idem);
      router.push(`/workflows/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting('');
    }
  };

  return (
    <div>
      <h1 className="page-title">Workflows</h1>
      <p className="page-sub">Registered workflow definitions and their runs.</p>
      {error && <div className="error-box">{error}</div>}

      <div className="grid-2">
        {defs.map((d) => (
          <div key={d.id} className="card">
            <div className="row-between">
              <strong>{d.name}</strong>
              <span className="chip gray mono">{d.id}</span>
            </div>
            {d.description && <p className="small muted">{d.description}</p>}
            <p className="small muted">
              {d.nodes.length} node(s): {d.nodes.map((n) => n.id).join(', ')}
            </p>
            <div className="field">
              <label className="label" htmlFor={`input-${d.id}`}>
                Input JSON (optional)
              </label>
              <textarea
                id={`input-${d.id}`}
                className="textarea"
                rows={2}
                placeholder='{"key": "value"}'
                value={inputs[d.id] ?? ''}
                onChange={(e) => setInputs((s) => ({ ...s, [d.id]: e.target.value }))}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={`idem-${d.id}`}>
                Idempotency key (optional)
              </label>
              <input
                id={`idem-${d.id}`}
                className="input"
                placeholder="unique key per logical run"
                value={idemKeys[d.id] ?? ''}
                onChange={(e) => setIdemKeys((s) => ({ ...s, [d.id]: e.target.value }))}
              />
            </div>
            <button
              className="btn btn-primary btn-sm"
              disabled={starting === d.id}
              onClick={() => void start(d)}
            >
              {starting === d.id ? 'Starting…' : 'Run'}
            </button>
          </div>
        ))}
      </div>
      {defs.length === 0 && <p className="muted">No workflow definitions registered.</p>}

      <h3 className="mt">Runs</h3>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Run</th>
              <th>Workflow</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/workflows/${r.id}`} className="mono" style={{ color: 'var(--accent)' }}>
                    {r.id.slice(0, 8)}…
                  </Link>
                </td>
                <td className="mono">{r.workflowId}</td>
                <td>{statusChip(r.status)}</td>
                <td className="small muted">{fmtTs(r.createdAt)}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

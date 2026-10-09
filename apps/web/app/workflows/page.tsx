// SPDX-License-Identifier: Apache-2.0
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { getRunHealth, getRuns, getWorkflows, runWorkflow } from '../../lib/api';
import type { HealthScore, RunHealth, WorkflowDefinition, WorkflowRun } from '../../lib/api';

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function statusChip(status: WorkflowRun['status']) {
  const cls =
    status === 'succeeded' ? 'green' : status === 'failed' ? 'red' : status === 'paused' ? 'amber' : 'blue';
  return <span className={`chip ${cls}`}>{status}</span>;
}

/** Run-health verdict chip (feature #2): turns the runs log into a coach. */
function healthChip(score?: HealthScore) {
  if (!score) return <span className="chip gray">—</span>;
  const cls = score === 'good' ? 'green' : score === 'needs-work' ? 'amber' : 'red';
  const label = score === 'good' ? 'Good' : score === 'needs-work' ? 'Needs work' : 'Poor';
  return <span className={`chip ${cls}`}>{label}</span>;
}

const SEVERITY_CLS: Record<string, string> = { critical: 'red', warning: 'amber', info: 'gray' };

export default function WorkflowsPage() {
  const router = useRouter();
  const [defs, setDefs] = useState<WorkflowDefinition[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<string>('');
  // Per-definition run form state.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [idemKeys, setIdemKeys] = useState<Record<string, string>>({});
  // Expandable health diagnosis per run (feature #2).
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diagnoses, setDiagnoses] = useState<Record<string, RunHealth>>({});
  const [diagLoading, setDiagLoading] = useState<string | null>(null);

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

  const toggleDiagnosis = (runId: string) => {
    if (expanded === runId) {
      setExpanded(null);
      return;
    }
    setExpanded(runId);
    if (!diagnoses[runId] && diagLoading !== runId) {
      setDiagLoading(runId);
      getRunHealth(runId)
        .then((h) => setDiagnoses((d) => ({ ...d, [runId]: h })))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setDiagLoading(null));
    }
  };

  const start = async (def: WorkflowDefinition) => {    const rawInput = (inputs[def.id] ?? '').trim();
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
              <th>Health</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.flatMap((r) => {
              const isOpen = expanded === r.id;
              const diag = diagnoses[r.id];
              const rows = [
                <tr key={r.id}>
                  <td>
                    <Link href={`/workflows/${r.id}`} className="mono" style={{ color: 'var(--accent)' }}>
                      {r.id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="mono">{r.workflowId}</td>
                  <td>{statusChip(r.status)}</td>
                  <td>
                    <button
                      className="btn btn-sm"
                      onClick={() => toggleDiagnosis(r.id)}
                      aria-expanded={isOpen}
                      aria-label={`Health diagnosis for run ${r.id.slice(0, 8)}`}
                      title="Show diagnosis and suggested fixes"
                    >
                      {healthChip(r.healthScore)} {isOpen ? '▾' : '▸'}
                    </button>
                  </td>
                  <td className="small muted">{fmtTs(r.createdAt)}</td>
                </tr>,
              ];
              if (isOpen) {
                rows.push(
                  <tr key={`${r.id}-diag`}>
                    <td colSpan={5} style={{ background: 'var(--bg-subtle, transparent)' }}>
                      {diagLoading === r.id && !diag ? (
                        <p className="small muted">Loading diagnosis…</p>
                      ) : diag ? (
                        <div>
                          <strong className="small">Health diagnosis</strong>
                          {diag.findings.length === 0 ? (
                            <p className="small muted">Clean run — no issues detected.</p>
                          ) : (
                            <ul className="brief-list">
                              {diag.findings.map((f, i) => (
                                <li key={i} className="brief-item">
                                  <div className="row gap">
                                    <span className={`chip ${SEVERITY_CLS[f.severity] ?? 'gray'}`}>{f.severity}</span>
                                    <strong className="small">{f.title}</strong>
                                    {f.nodeId && <span className="small muted mono">{f.nodeId}</span>}
                                  </div>
                                  <div className="brief-item-detail small">{f.detail}</div>
                                  <div className="brief-item-detail small">
                                    <strong>Fix:</strong> {f.fix}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        <p className="small muted">Diagnosis unavailable.</p>
                      )}
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
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

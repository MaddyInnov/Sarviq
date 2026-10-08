// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import { decideApproval, getApprovals } from '../../lib/api';
import type { ApprovalRecord } from '../../lib/api';

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function ApprovalsPage() {
  const [pending, setPending] = useState<ApprovalRecord[]>([]);
  const [decided, setDecided] = useState<ApprovalRecord[]>([]);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string>('');

  const refresh = useCallback(async () => {
    try {
      const [p, all] = await Promise.all([getApprovals('pending'), getApprovals()]);
      setPending(p);
      setDecided(all.filter((a) => a.status !== 'pending').slice(0, 20));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    setActing(id);
    try {
      await decideApproval(id, decision);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing('');
    }
  };

  return (
    <div>
      <h1 className="page-title">Approvals</h1>
      <p className="page-sub">
        Human-in-the-loop gate for tool calls. Pending items refresh every 3 seconds.
      </p>
      {error && <div className="error-box">{error}</div>}

      <h3>Pending ({pending.length})</h3>
      {pending.length === 0 && <p className="muted">Nothing waiting for a decision.</p>}
      {pending.map((a) => (
        <div key={a.id} className="card">
          <div className="row-between">
            <div>
              <strong className="mono">{a.toolName}</strong>{' '}
              <span className="chip amber">pending</span>
            </div>
            <span className="small muted">{fmtTs(a.ts)}</span>
          </div>
          <div className="small muted mt">
            bot <span className="mono">{a.botId}</span> · session{' '}
            <span className="mono">{a.sessionId}</span> · actor{' '}
            <span className="mono">{a.actor}</span>
          </div>
          <pre className="mono small mt" style={{ maxHeight: 160, overflow: 'auto' }}>
            {prettyJson(a.args)}
          </pre>
          <div className="approval-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={acting === a.id}
              onClick={() => void decide(a.id, 'approved')}
            >
              Approve
            </button>
            <button
              className="btn btn-danger btn-sm"
              disabled={acting === a.id}
              onClick={() => void decide(a.id, 'denied')}
            >
              Deny
            </button>
          </div>
        </div>
      ))}

      <h3 className="mt">Recently decided</h3>
      {decided.length === 0 && <p className="muted">No decisions yet.</p>}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Status</th>
              <th>Bot</th>
              <th>Decided</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {decided.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.toolName}</td>
                <td>
                  <span className={`chip ${a.status === 'approved' ? 'green' : a.status === 'denied' ? 'red' : 'gray'}`}>
                    {a.status}
                  </span>
                </td>
                <td className="mono">{a.botId}</td>
                <td className="small muted">{a.decidedAt ? fmtTs(a.decidedAt) : '—'}</td>
                <td className="small muted truncate">{a.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, useModuleData } from '../lib';

interface BrowserActionRequest {
  id: string;
  action: 'navigate' | 'extract_text' | 'screenshot';
  url: string | null;
  status: 'pending' | 'approved' | 'denied' | 'executed';
  resultJson: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export default function BrowserPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const loadApprovals = useCallback(
    () =>
      api(`${MODULES_BASE}/browser/approvals${statusFilter ? `?status=${statusFilter}` : ''}`) as Promise<
        BrowserActionRequest[]
      >,
    [statusFilter],
  );
  const { data: approvals, error, refresh } = useModuleData(loadApprovals);
  const [action, setAction] = useState<'navigate' | 'extract_text' | 'screenshot'>('extract_text');
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<BrowserActionRequest | null>(null);

  const request = async () => {
    if (!url.trim()) return;
    const r = (await api(`${MODULES_BASE}/browser/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, url: url.trim() }),
    })) as BrowserActionRequest;
    setUrl('');
    refresh();
    setSelected(r);
  };

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    const r = (await api(`${MODULES_BASE}/browser/approvals/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    })) as BrowserActionRequest;
    setSelected(r);
    refresh();
  };

  const execute = async (id: string) => {
    const r = (await api(`${MODULES_BASE}/browser/approvals/${id}/execute`, {
      method: 'POST',
    })) as BrowserActionRequest;
    setSelected(r);
    refresh();
  };

  const statusChip = (s: BrowserActionRequest['status']) => (
    <span className={`chip${s === 'denied' ? ' red' : s === 'executed' ? ' green' : s === 'approved' ? ' amber' : ' gray'}`}>
      {s}
    </span>
  );

  return (
    <div>
      <PageHeader
        title="Browser"
        sub="Approval-gated web actions: navigate, extract text, screenshot. Nothing runs without your approval."
        onRefresh={refresh}
      />
      <ErrorBox error={error} />

      <div className="card">
        <strong>Request a browser action</strong>
        <div className="grid-2 mt">
          <div className="tabs" role="tablist">
            {(['navigate', 'extract_text', 'screenshot'] as const).map((a) => (
              <button
                key={a}
                role="tab"
                aria-selected={action === a}
                className={`tab${action === a ? ' active' : ''}`}
                onClick={() => setAction(a)}
              >
                {a}
              </button>
            ))}
          </div>
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
          />
        </div>
        <div className="mt">
          <button className="btn btn-sm" disabled={!url.trim()} onClick={() => void request()}>
            Request
          </button>
        </div>
      </div>

      <div className="row-between mt">
        <div className="tabs" role="tablist">
          {(['', 'pending', 'approved', 'denied', 'executed'] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={statusFilter === s}
              className={`tab${statusFilter === s ? ' active' : ''}`}
              onClick={() => setStatusFilter(s)}
            >
              {s === '' ? 'All' : s}
            </button>
          ))}
        </div>
      </div>

      <div className="grid-2 mt">
        <div>
          {(approvals ?? []).map((a) => (
            <div className={`card${selected?.id === a.id ? ' active' : ''}`} key={a.id}>
              <div className="row-between">
                <span className="mono small">{a.action}</span>
                {statusChip(a.status)}
              </div>
              <p className="small muted mt">{a.url ?? '—'}</p>
              <p className="small muted">{fmtTs(a.createdAt)}</p>
              <div className="mt">
                <button className="btn btn-sm" onClick={() => setSelected(a)}>
                  Details
                </button>
              </div>
            </div>
          ))}
          {(approvals ?? []).length === 0 && <EmptyState text="No browser actions yet." />}
        </div>

        <div>
          {selected ? (
            <div className="card">
              <div className="row-between">
                <strong className="mono">{selected.action}</strong>
                {statusChip(selected.status)}
              </div>
              <p className="small muted mt">{selected.url ?? '—'}</p>
              <p className="small muted">Requested {fmtTs(selected.createdAt)}</p>
              {selected.decidedAt && <p className="small muted">Decided {fmtTs(selected.decidedAt)}</p>}
              {selected.resultJson && (
                <pre className="mono small mt" style={{ whiteSpace: 'pre-wrap' }}>
                  {selected.resultJson}
                </pre>
              )}
              <div className="row-between mt">
                <button className="btn btn-sm" onClick={() => setSelected(null)}>
                  Close
                </button>
                <span>
                  {selected.status === 'pending' && (
                    <>
                      <button className="btn btn-sm" onClick={() => void decide(selected.id, 'approved')}>
                        Approve
                      </button>{' '}
                      <button className="btn btn-sm" onClick={() => void decide(selected.id, 'denied')}>
                        Deny
                      </button>
                    </>
                  )}
                  {selected.status === 'approved' && (
                    <button className="btn btn-sm" onClick={() => void execute(selected.id)}>
                      Execute
                    </button>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <EmptyState text="Select an action to review it." />
          )}
        </div>
      </div>
    </div>
  );
}

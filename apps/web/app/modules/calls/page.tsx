// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, useModuleData } from '../lib';

interface CallRecord {
  id: string;
  direction: 'inbound' | 'outbound';
  peer: string;
  startedAt: number;
  durationSec: number;
  summary: string;
  recordingRef: string | null;
  status: 'completed' | 'simulated' | 'failed';
}

export default function CallsPage() {
  const loadCalls = useCallback(() => api(`${MODULES_BASE}/calls?limit=50`) as Promise<CallRecord[]>, []);
  const { data: calls, error, refresh } = useModuleData(loadCalls);
  const [to, setTo] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);

  const placeCall = async () => {
    if (!to.trim()) return;
    setBusy(true);
    try {
      await api(`${MODULES_BASE}/calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim(), summary: summary.trim() || undefined }),
      });
      setTo('');
      setSummary('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Calls" sub="Voice call log. Simulated records only — real telephony is out of scope." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>Place a call (simulated)</strong>
        <div className="grid-2 mt">
          <input
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Peer (e.g. +15551234567)"
          />
          <input
            className="input"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Summary (optional)"
          />
        </div>
        <div className="mt">
          <button className="btn btn-sm" disabled={busy || !to.trim()} onClick={() => void placeCall()}>
            Place call
          </button>
        </div>
      </div>

      <div className="mt">
        {(calls ?? []).map((c) => (
          <div className="card" key={c.id}>
            <div className="row-between">
              <strong className="mono">{c.peer}</strong>
              <span className={`chip${c.status === 'failed' ? ' red' : c.status === 'completed' ? ' green' : ' gray'}`}>
                {c.status}
              </span>
            </div>
            <p className="small muted mt">
              {c.direction} · {fmtTs(c.startedAt)} · {c.durationSec}s
            </p>
            {c.summary && <p className="small mt">{c.summary}</p>}
            {c.recordingRef && <p className="small muted mt mono">Recording: {c.recordingRef}</p>}
          </div>
        ))}
      </div>
      {(calls ?? []).length === 0 && <EmptyState text="No calls logged yet." />}
    </div>
  );
}

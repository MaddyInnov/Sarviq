// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, Markdown, useModuleData } from '../lib';

interface ResearchSource {
  id: string;
  title: string;
  url: string;
  snippet: string;
}

interface ResearchStep {
  n: number;
  question: string;
}

interface ResearchReport {
  id: string;
  query: string;
  plan: ResearchStep[];
  sources: ResearchSource[];
  reportMd: string;
  createdAt: number;
}

export default function ResearchPage() {
  const loadReports = useCallback(() => api(`${MODULES_BASE}/research`) as Promise<ResearchReport[]>, []);
  const { data: reports, error, refresh } = useModuleData(loadReports);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ResearchReport | null>(null);

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const report = (await api(`${MODULES_BASE}/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      })) as ResearchReport;
      setQuery('');
      refresh();
      setSelected(report);
    } finally {
      setBusy(false);
    }
  };

  const openReport = async (id: string) => {
    const r = (await api(`${MODULES_BASE}/research/${id}`)) as ResearchReport;
    setSelected(r);
  };

  return (
    <div>
      <PageHeader title="Research" sub="Deep-research agent: plan → gather → synthesize, with cited sources." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>New research</strong>
        <div className="row-between mt">
          <input
            className="input"
            style={{ flex: 1, marginRight: 8 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What should I research?"
          />
          <button className="btn" disabled={busy || !query.trim()} onClick={() => void run()}>
            {busy ? 'Researching…' : 'Run research'}
          </button>
        </div>
      </div>

      <div className="grid-2 mt">
        <div>
          {(reports ?? []).map((r) => (
            <div className={`card${selected?.id === r.id ? ' active' : ''}`} key={r.id}>
              <strong>{r.query}</strong>
              <p className="small muted mt">
                {fmtTs(r.createdAt)} · {r.sources.length} sources
              </p>
              <div className="mt">
                <button className="btn btn-sm" onClick={() => void openReport(r.id)}>
                  Open report
                </button>
              </div>
            </div>
          ))}
          {(reports ?? []).length === 0 && <EmptyState text="No reports yet. Run your first research above." />}
        </div>

        <div>
          {selected ? (
            <div className="card">
              <div className="row-between">
                <strong>{selected.query}</strong>
                <button className="btn btn-sm" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
              <p className="small muted mt">{fmtTs(selected.createdAt)}</p>
              {selected.plan.length > 0 && (
                <div className="mt">
                  <strong className="small">Plan</strong>
                  <ol className="small mt">
                    {selected.plan.map((s) => (
                      <li key={s.n}>{s.question}</li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="mt">
                <Markdown src={selected.reportMd} />
              </div>
              {selected.sources.length > 0 && (
                <div className="mt">
                  <strong className="small">Sources</strong>
                  {selected.sources.map((s) => (
                    <div key={s.id} className="small mt">
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                      <p className="muted">{s.snippet}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <EmptyState text="Select a report to read it." />
          )}
        </div>
      </div>
    </div>
  );
}

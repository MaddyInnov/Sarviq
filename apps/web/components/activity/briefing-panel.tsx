// SPDX-License-Identifier: Apache-2.0
'use client';

// Daily Briefing surface: overnight activity, today's calendar, and pending
// approvals in one digest card. Backed by GET /api/briefing; when the backend
// is not built yet the panel renders an empty state (never an error).

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorBox } from '../../app/modules/lib';
import { getBriefing } from '../../lib/sarviq-api';
import type { Briefing, BriefingItem } from '../../lib/sarviq-api';

function fmtTs(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function ItemList({ items }: { items: BriefingItem[] }) {
  if (items.length === 0) return <p className="muted small">Nothing here.</p>;
  return (
    <ul className="brief-list">
      {items.map((it, i) => (
        <li key={it.id ?? `${it.title}-${i}`} className="brief-item">
          <div className="brief-item-title">{it.title}</div>
          {it.detail && <div className="brief-item-detail small muted">{it.detail}</div>}
          {it.ts ? <div className="brief-item-ts small muted">{fmtTs(it.ts)}</div> : null}
        </li>
      ))}
    </ul>
  );
}

export function BriefingPanel() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const b = await getBriefing();
      setMissing(b === null);
      setBriefing(b);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (missing || briefing === null) {
    return (
      <EmptyState text="No briefing yet — the daily digest service is not available. Your morning summary will appear here once it is." />
    );
  }

  return (
    <div>
      <div className="row-between">
        <h3 className="mt0">Daily briefing</h3>
        <span className="small muted">
          Generated {briefing.generatedAt ? fmtTs(briefing.generatedAt) : '—'}
        </span>
      </div>
      {briefing.summary && <p className="brief-summary">{briefing.summary}</p>}
      <div className="grid-2">
        <div className="card">
          <h4>Overnight</h4>
          <ItemList items={briefing.overnight ?? []} />
        </div>
        <div className="card">
          <h4>Today&apos;s calendar</h4>
          <ItemList items={briefing.calendar ?? []} />
        </div>
      </div>
      <div className="card">
        <h4>Needs your approval</h4>
        <ItemList items={briefing.approvals ?? []} />
      </div>
    </div>
  );
}

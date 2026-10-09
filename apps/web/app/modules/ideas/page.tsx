// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, useModuleData } from '../lib';

interface Idea {
  id: string;
  title: string;
  description: string;
  status: 'new' | 'active' | 'done' | 'dismissed';
  createdAt: number;
  updatedAt: number;
}

export default function IdeasPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const loadIdeas = useCallback(
    () => api(`${MODULES_BASE}/ideas${statusFilter ? `?status=${statusFilter}` : ''}`) as Promise<Idea[]>,
    [statusFilter],
  );
  const { data: ideas, error, refresh } = useModuleData(loadIdeas);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const create = async () => {
    if (!title.trim()) return;
    await api(`${MODULES_BASE}/ideas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined }),
    });
    setTitle('');
    setDescription('');
    refresh();
  };

  const transition = async (id: string, op: 'run' | 'dismiss' | 'complete') => {
    await api(`${MODULES_BASE}/ideas/${id}/${op}`, { method: 'POST' });
    refresh();
  };

  const statusChip = (s: Idea['status']) => (
    <span className={`chip${s === 'done' ? ' green' : s === 'dismissed' ? ' red' : s === 'active' ? ' amber' : ' gray'}`}>
      {s}
    </span>
  );

  return (
    <div>
      <PageHeader title="Ideas" sub="Capture ideas, triage them: new → active → done / dismissed." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>Capture an idea</strong>
        <div className="grid-2 mt">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Idea title"
          />
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
          />
        </div>
        <div className="mt">
          <button className="btn btn-sm" disabled={!title.trim()} onClick={() => void create()}>
            Capture
          </button>
        </div>
      </div>

      <div className="tabs mt" role="tablist">
        {(['', 'new', 'active', 'done', 'dismissed'] as const).map((s) => (
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

      <div className="grid-2 mt">
        {(ideas ?? []).map((i) => (
          <div className="card" key={i.id}>
            <div className="row-between">
              <strong>{i.title}</strong>
              {statusChip(i.status)}
            </div>
            {i.description && <p className="small muted mt">{i.description}</p>}
            <p className="small muted mt">{fmtTs(i.createdAt)}</p>
            <div className="mt">
              {i.status === 'new' && (
                <>
                  <button className="btn btn-sm" onClick={() => void transition(i.id, 'run')}>
                    Run
                  </button>{' '}
                  <button className="btn btn-sm" onClick={() => void transition(i.id, 'dismiss')}>
                    Dismiss
                  </button>
                </>
              )}
              {i.status === 'active' && (
                <button className="btn btn-sm" onClick={() => void transition(i.id, 'complete')}>
                  Complete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {(ideas ?? []).length === 0 && <EmptyState text="No ideas yet. Capture one above." />}
    </div>
  );
}

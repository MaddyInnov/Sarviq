// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, Markdown, useModuleData } from '../lib';

interface FeedBrief {
  brief: string;
  updatedAt: number;
}

interface FeedPost {
  id: string;
  title: string;
  body: string;
  sourceNote: string | null;
  dismissed: boolean;
  createdAt: number;
}

export default function FeedPage() {
  const loadPosts = useCallback(() => api(`${MODULES_BASE}/feed/posts`) as Promise<FeedPost[]>, []);
  const { data: posts, error, refresh } = useModuleData(loadPosts);
  const [brief, setBrief] = useState('');
  const [briefLoaded, setBriefLoaded] = useState(false);
  const [briefMsg, setBriefMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadBrief = useCallback(async () => {
    try {
      const b = (await api(`${MODULES_BASE}/feed/brief`)) as FeedBrief;
      setBrief(b.brief ?? '');
      setBriefLoaded(true);
    } catch {
      setBriefLoaded(true);
    }
  }, []);
  useEffect(() => {
    void loadBrief();
  }, [loadBrief]);

  const saveBrief = async () => {
    setBusy(true);
    try {
      await api(`${MODULES_BASE}/feed/brief`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief }),
      });
      setBriefMsg('Brief saved.');
    } catch (err) {
      setBriefMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    try {
      await api(`${MODULES_BASE}/feed/posts/generate`, { method: 'POST' });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (id: string) => {
    await api(`${MODULES_BASE}/feed/posts/${id}/dismiss`, { method: 'POST' });
    refresh();
  };

  const visible = (posts ?? []).filter((p) => !p.dismissed);

  return (
    <div>
      <PageHeader
        title="Feed"
        sub="Your proactive feed: a stored brief plus background-generated posts."
        onRefresh={refresh}
      />
      <ErrorBox error={error} />

      <div className="card">
        <strong>Your brief</strong>
        <p className="small muted">What should the feed watch for? The generator uses this to pick posts.</p>
        <textarea
          className="input mt"
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={briefLoaded ? 'e.g. AI agent frameworks, TypeScript, indie hacking…' : 'Loading…'}
        />
        <div className="row-between mt">
          <span className="small muted">{briefMsg}</span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void saveBrief()}>
            Save brief
          </button>
        </div>
      </div>

      <div className="row-between mt">
        <strong>{visible.length} posts</strong>
        <button className="btn btn-sm" disabled={busy} onClick={() => void generate()}>
          Generate posts
        </button>
      </div>

      <div className="grid-2 mt">
        {visible.map((p) => (
          <div className="card" key={p.id}>
            <div className="row-between">
              <strong>{p.title}</strong>
              <span className="small muted">{fmtTs(p.createdAt)}</span>
            </div>
            <div className="mt small">
              <Markdown src={p.body} />
            </div>
            {p.sourceNote && <p className="small muted mt">Source: {p.sourceNote}</p>}
            <div className="mt">
              <button className="btn btn-sm" onClick={() => void dismiss(p.id)}>
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
      {visible.length === 0 && <EmptyState text="No posts yet. Save a brief, then hit Generate posts." />}
    </div>
  );
}

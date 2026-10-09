// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, Markdown, useModuleData } from '../lib';

interface WatchKeyword {
  id: string;
  keyword: string;
  createdAt: number;
}

interface SocialPost {
  id: string;
  platform: 'x' | 'reddit' | 'youtube' | 'instagram';
  author: string;
  text: string;
  url: string;
  keyword: string;
  postedAt: number;
}

interface KeywordDigest {
  keyword: string;
  posts: SocialPost[];
}

interface DigestResponse {
  digest: KeywordDigest[];
  markdown: string;
}

export default function SocialPage() {
  const loadWatchlist = useCallback(() => api(`${MODULES_BASE}/social/watchlist`) as Promise<WatchKeyword[]>, []);
  const { data: watchlist, error, refresh } = useModuleData(loadWatchlist);
  const [keyword, setKeyword] = useState('');
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'cards' | 'markdown'>('cards');

  const add = async () => {
    if (!keyword.trim()) return;
    await api(`${MODULES_BASE}/social/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: keyword.trim() }),
    });
    setKeyword('');
    refresh();
  };

  const remove = async (id: string) => {
    await api(`${MODULES_BASE}/social/watchlist/${id}`, { method: 'DELETE' });
    refresh();
  };

  const buildDigest = async () => {
    setBusy(true);
    try {
      const d = (await api(`${MODULES_BASE}/social/digest`)) as DigestResponse;
      setDigest(d);
    } finally {
      setBusy(false);
    }
  };

  const platformChip = (p: SocialPost['platform']) => <span className="chip gray">{p}</span>;

  return (
    <div>
      <PageHeader title="Social" sub="Social listening: keyword watchlist, mock social search, digest." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>Watchlist</strong>
        <div className="row-between mt">
          <input
            className="input"
            style={{ flex: 1, marginRight: 8 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Keyword to watch…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
          <button className="btn btn-sm" disabled={!keyword.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
        <div className="mt">
          {(watchlist ?? []).map((w) => (
            <span key={w.id} className="chip" style={{ marginRight: 6, marginBottom: 6, display: 'inline-block' }}>
              {w.keyword}{' '}
              <button
                aria-label={`Remove ${w.keyword}`}
                onClick={() => void remove(w.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)' }}
              >
                ×
              </button>
            </span>
          ))}
          {(watchlist ?? []).length === 0 && <p className="small muted">No keywords watched yet.</p>}
        </div>
        <div className="mt">
          <button className="btn" disabled={busy || (watchlist ?? []).length === 0} onClick={() => void buildDigest()}>
            {busy ? 'Building…' : 'Build digest'}
          </button>
        </div>
      </div>

      {digest && (
        <div className="mt">
          <div className="row-between">
            <strong>Digest</strong>
            <div className="tabs" role="tablist">
              {(['cards', 'markdown'] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  className={`tab${view === v ? ' active' : ''}`}
                  onClick={() => setView(v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          {view === 'markdown' ? (
            <div className="card mt">
              <Markdown src={digest.markdown} />
            </div>
          ) : (
            <div className="mt">
              {digest.digest.map((kd) => (
                <div className="card mt" key={kd.keyword}>
                  <strong>#{kd.keyword}</strong>
                  {kd.posts.map((p) => (
                    <div key={p.id} className="mt small">
                      <div className="row-between">
                        {platformChip(p.platform)}
                        <span className="small muted">
                          {p.author} · {fmtTs(p.postedAt)}
                        </span>
                      </div>
                      <p className="mt">{p.text}</p>
                      <a href={p.url} target="_blank" rel="noreferrer" className="small">
                        Open →
                      </a>
                    </div>
                  ))}
                  {kd.posts.length === 0 && <p className="small muted mt">No posts found.</p>}
                </div>
              ))}
              {digest.digest.length === 0 && <EmptyState text="Digest is empty." />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

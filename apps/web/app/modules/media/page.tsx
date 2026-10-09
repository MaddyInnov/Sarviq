// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import { MODULES_BASE, api, PageHeader, ErrorBox } from '../lib';

interface MediaAsset {
  id: string;
  kind: 'image' | 'video' | 'audio';
  prompt: string;
  url: string;
  mimeType: string;
  byteLength: number;
  provider: string;
}

export default function MediaPage() {
  const [kind, setKind] = useState<'image' | 'video' | 'audio'>('image');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [assets, setAssets] = useState<MediaAsset[]>([]);

  const generate = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError('');
    try {
      const asset = (await api(`${MODULES_BASE}/media/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, prompt: prompt.trim() }),
      })) as MediaAsset;
      setAssets((a) => [asset, ...a]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const renderAsset = (a: MediaAsset) => {
    if (a.url.startsWith('mock://')) {
      return <p className="small muted">Mock asset — no real bytes (provider: {a.provider}).</p>;
    }
    if (a.kind === 'image') {
      return <img src={a.url} alt={a.prompt} style={{ maxWidth: '100%', borderRadius: 12 }} />;
    }
    if (a.kind === 'video') {
      return (
        <video controls style={{ maxWidth: '100%', borderRadius: 12 }}>
          <source src={a.url} type={a.mimeType} />
        </video>
      );
    }
    return (
      <audio controls style={{ width: '100%' }}>
        <source src={a.url} type={a.mimeType} />
      </audio>
    );
  };

  return (
    <div>
      <PageHeader title="Media" sub="Generate images, video, and audio. Mock provider until founder keys land." />
      <ErrorBox error={error} />

      <div className="card">
        <div className="tabs" role="tablist">
          {(['image', 'video', 'audio'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={`tab${kind === k ? ' active' : ''}`}
              onClick={() => setKind(k)}
            >
              {k}
            </button>
          ))}
        </div>
        <textarea
          className="input mt"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`Describe the ${kind} you want…`}
        />
        <div className="mt">
          <button className="btn" disabled={busy || !prompt.trim()} onClick={() => void generate()}>
            {busy ? 'Generating…' : `Generate ${kind}`}
          </button>
        </div>
      </div>

      <div className="grid-2 mt">
        {assets.map((a) => (
          <div className="card" key={a.id}>
            <div className="row-between">
              <span className="chip gray">{a.kind}</span>
              <span className="small muted">{a.provider}</span>
            </div>
            <p className="small mt">{a.prompt}</p>
            <div className="mt">{renderAsset(a)}</div>
            <p className="small muted mt mono">{a.url}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

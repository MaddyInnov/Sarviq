// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState } from '../lib';

interface Meeting {
  id: string;
  title: string;
  pageId: string;
  fileName: string;
  durationMs?: number;
  createdAt: number;
}

interface MeetingSummary {
  summary: string;
  actionItems: string[];
  keyDecisions: string[];
}

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [result, setResult] = useState<{ meeting: Meeting; summary: MeetingSummary } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setMeetings((await api(`${MODULES_BASE}/meetings`)) as Meeting[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose an audio file first.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ''),
      );
      const res = (await api(`${MODULES_BASE}/meetings/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, audioBase64: base64, title: title.trim() || undefined }),
      })) as { meeting: Meeting; pageId: string; summary: MeetingSummary };
      setResult({ meeting: res.meeting, summary: res.summary });
      setTitle('');
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Meetings"
        sub="Upload a recording → transcript → AI summary with action items, saved as a Page. Audio is deleted after processing."
      />
      {error && <ErrorBox error={error} />}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3>New meeting notes</h3>
        <div className="row">
          <input
            className="input"
            placeholder="Title (optional — defaults to date)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input ref={fileRef} type="file" accept=".mp3,.wav,.m4a,.ogg,.webm,audio/*" className="input" />
          <button className="btn primary" onClick={upload} disabled={busy}>
            {busy ? 'Processing…' : 'Upload & summarize'}
          </button>
        </div>
        <p className="muted small">Max 100 MiB. Supported: mp3, wav, m4a, ogg, webm.</p>
      </div>

      {result && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>{result.meeting.title}</h3>
          <p>{result.summary.summary}</p>
          {result.summary.actionItems.length > 0 && (
            <>
              <h4>Action items</h4>
              <ul>
                {result.summary.actionItems.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {result.summary.keyDecisions.length > 0 && (
            <>
              <h4>Key decisions</h4>
              <ul>
                {result.summary.keyDecisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </>
          )}
          <a className="btn small" href={`/pages`}>
            Open in Pages
          </a>
        </div>
      )}

      {meetings.length === 0 ? (
        <EmptyState text="No meetings yet. Upload a recording above to generate notes." />
      ) : (
        <div className="card">
          <h3>Past meetings</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>File</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td className="muted small">{m.fileName}</td>
                  <td className="muted small">{fmtTs(m.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

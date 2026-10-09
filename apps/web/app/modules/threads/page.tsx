// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, useModuleData } from '../lib';

interface SideThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface ThreadMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

export default function ThreadsPage() {
  const loadThreads = useCallback(() => api(`${MODULES_BASE}/threads`) as Promise<SideThread[]>, []);
  const { data: threads, error, refresh } = useModuleData(loadThreads);
  const [newTitle, setNewTitle] = useState('');
  const [selected, setSelected] = useState<SideThread | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');

  const create = async () => {
    const t = (await api(`${MODULES_BASE}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() || undefined }),
    })) as SideThread;
    setNewTitle('');
    refresh();
    void openThread(t);
  };

  const openThread = async (t: SideThread) => {
    setSelected(t);
    setRenaming(false);
    const full = (await api(`${MODULES_BASE}/threads/${t.id}`)) as SideThread & { messages?: ThreadMessage[] };
    setMessages(full.messages ?? []);
  };

  const sendMessage = async () => {
    if (!selected || !draft.trim()) return;
    const m = (await api(`${MODULES_BASE}/threads/${selected.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: draft.trim() }),
    })) as ThreadMessage;
    setMessages((ms) => [...ms, m]);
    setDraft('');
  };

  const rename = async () => {
    if (!selected || !renameTitle.trim()) return;
    const t = (await api(`${MODULES_BASE}/threads/${selected.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: renameTitle.trim() }),
    })) as SideThread;
    setSelected(t);
    setRenaming(false);
    refresh();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this thread?')) return;
    await api(`${MODULES_BASE}/threads/${id}`, { method: 'DELETE' });
    if (selected?.id === id) {
      setSelected(null);
      setMessages([]);
    }
    refresh();
  };

  return (
    <div>
      <PageHeader title="Threads" sub="Side chats — persistent conversations separate from main sessions." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>New thread</strong>
        <div className="row-between mt">
          <input
            className="input"
            style={{ flex: 1, marginRight: 8 }}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Thread title (optional)"
          />
          <button className="btn btn-sm" onClick={() => void create()}>
            Create
          </button>
        </div>
      </div>

      <div className="grid-2 mt">
        <div>
          {(threads ?? []).map((t) => (
            <div className={`card${selected?.id === t.id ? ' active' : ''}`} key={t.id}>
              <div className="row-between">
                <strong>{t.title || '(untitled)'}</strong>
                <span className="small muted">{fmtTs(t.updatedAt)}</span>
              </div>
              <div className="row-between mt">
                <button className="btn btn-sm" onClick={() => void openThread(t)}>
                  Open
                </button>
                <button className="btn btn-sm" onClick={() => void remove(t.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          {(threads ?? []).length === 0 && <EmptyState text="No threads yet. Create one above." />}
        </div>

        <div>
          {selected ? (
            <div className="card">
              <div className="row-between">
                {renaming ? (
                  <span>
                    <input
                      className="input"
                      value={renameTitle}
                      onChange={(e) => setRenameTitle(e.target.value)}
                      placeholder="New title"
                    />
                    <button className="btn btn-sm mt" onClick={() => void rename()}>
                      Save
                    </button>
                  </span>
                ) : (
                  <strong>{selected.title || '(untitled)'}</strong>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setRenaming(!renaming);
                    setRenameTitle(selected.title);
                  }}
                >
                  Rename
                </button>
              </div>
              <div className="mt" style={{ maxHeight: 320, overflowY: 'auto' }}>
                {messages.map((m) => (
                  <div key={m.id} className={`msg ${m.role} small`}>
                    <span className="small muted">{m.role} · {fmtTs(m.createdAt)}</span>
                    <div className="mt">{m.content}</div>
                  </div>
                ))}
                {messages.length === 0 && <p className="small muted">No messages yet.</p>}
              </div>
              <div className="row-between mt">
                <input
                  className="input"
                  style={{ flex: 1, marginRight: 8 }}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Write a message…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void sendMessage();
                  }}
                />
                <button className="btn btn-sm" onClick={() => void sendMessage()}>
                  Send
                </button>
              </div>
            </div>
          ) : (
            <EmptyState text="Select a thread to view messages." />
          )}
        </div>
      </div>
    </div>
  );
}

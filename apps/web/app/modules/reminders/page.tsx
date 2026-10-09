// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useState } from 'react';
import { MODULES_BASE, api, fmtTs, PageHeader, ErrorBox, EmptyState, useModuleData } from '../lib';

interface Reminder {
  id: string;
  title: string;
  when: number;
  channel: 'push' | 'email' | 'sms';
  status: 'scheduled' | 'fired' | 'done' | 'cancelled';
  firedAt: number | null;
  createdAt: number;
}

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function RemindersPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const loadReminders = useCallback(
    () => api(`${MODULES_BASE}/reminders${statusFilter ? `?status=${statusFilter}` : ''}`) as Promise<Reminder[]>,
    [statusFilter],
  );
  const { data: reminders, error, refresh } = useModuleData(loadReminders);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');
  const [channel, setChannel] = useState<'push' | 'email' | 'sms'>('push');

  const create = async () => {
    if (!title.trim() || !when) return;
    await api(`${MODULES_BASE}/reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        when: new Date(when).getTime(),
        channel,
      }),
    });
    setTitle('');
    setWhen('');
    refresh();
  };

  const transition = async (id: string, op: 'cancel' | 'done' | 'fire') => {
    await api(`${MODULES_BASE}/reminders/${id}/${op}`, { method: 'POST' });
    refresh();
  };

  const statusChip = (s: Reminder['status']) => (
    <span className={`chip${s === 'done' ? ' green' : s === 'cancelled' ? ' red' : s === 'fired' ? ' amber' : ' gray'}`}>
      {s}
    </span>
  );

  return (
    <div>
      <PageHeader title="Reminders" sub="Never forget: schedule reminders across push, email, or SMS." onRefresh={refresh} />
      <ErrorBox error={error} />

      <div className="card">
        <strong>New reminder</strong>
        <div className="grid-2 mt">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Reminder title"
          />
          <input
            className="input"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </div>
        <div className="row-between mt">
          <div className="tabs" role="tablist">
            {(['push', 'email', 'sms'] as const).map((c) => (
              <button
                key={c}
                role="tab"
                aria-selected={channel === c}
                className={`tab${channel === c ? ' active' : ''}`}
                onClick={() => setChannel(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" disabled={!title.trim() || !when} onClick={() => void create()}>
            Schedule
          </button>
        </div>
      </div>

      <div className="tabs mt" role="tablist">
        {(['', 'scheduled', 'fired', 'done', 'cancelled'] as const).map((s) => (
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

      <div className="mt">
        {(reminders ?? []).map((r) => (
          <div className="card" key={r.id}>
            <div className="row-between">
              <strong>{r.title}</strong>
              {statusChip(r.status)}
            </div>
            <p className="small muted mt">
              Due {fmtTs(r.when)} · {r.channel}
              {r.firedAt ? ` · fired ${fmtTs(r.firedAt)}` : ''}
            </p>
            <div className="mt">
              {(r.status === 'scheduled' || r.status === 'fired') && (
                <>
                  <button className="btn btn-sm" onClick={() => void transition(r.id, 'done')}>
                    Done
                  </button>{' '}
                  <button className="btn btn-sm" onClick={() => void transition(r.id, 'cancel')}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {(reminders ?? []).length === 0 && <EmptyState text="No reminders. Schedule one above." />}
      <div className="mt">
        <button className="btn btn-sm" onClick={() => setWhen(toLocalInput(Date.now() + 3600000))}>
          Quick: +1 hour
        </button>
      </div>
    </div>
  );
}

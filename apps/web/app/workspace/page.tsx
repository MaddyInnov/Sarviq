// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import { NotesPanel } from '../../components/panels/notes-panel';
import { TasksPanel } from '../../components/panels/tasks-panel';

const TABS = [
  { id: 'notes', label: 'Notes' },
  { id: 'tasks', label: 'Tasks' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function WorkspacePage() {
  const [tab, setTab] = useState<TabId>('notes');
  return (
    <div>
      <h1 className="page-title">Workspace</h1>
      <p className="page-sub">Notes and tasks in one place — your personal working surface.</p>
      <div className="tabs" role="tablist" aria-label="Workspace sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tab-panel page-enter" key={tab} role="tabpanel">
        {tab === 'notes' ? <NotesPanel hideHeader /> : <TasksPanel hideHeader />}
      </div>
    </div>
  );
}

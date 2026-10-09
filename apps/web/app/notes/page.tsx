// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import { NotesPanel } from '../../components/panels/notes-panel';
import { DatabasesPanel } from '../../components/panels/databases-panel';

export default function NotesPage() {
  const [tab, setTab] = useState<'notes' | 'databases'>('notes');
  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Notes sections" style={{ marginBottom: 12 }}>
        <button
          role="tab"
          aria-selected={tab === 'notes'}
          className={`tab${tab === 'notes' ? ' active' : ''}`}
          onClick={() => setTab('notes')}
        >
          Notes
        </button>
        <button
          role="tab"
          aria-selected={tab === 'databases'}
          className={`tab${tab === 'databases' ? ' active' : ''}`}
          onClick={() => setTab('databases')}
        >
          Databases
        </button>
      </div>
      {tab === 'notes' ? <NotesPanel /> : <DatabasesPanel />}
    </div>
  );
}

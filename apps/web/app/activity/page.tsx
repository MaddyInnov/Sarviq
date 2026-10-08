// SPDX-License-Identifier: Apache-2.0
'use client';

import { useState } from 'react';
import { ApprovalsPanel } from '../../components/panels/approvals-panel';
import { AuditPanel } from '../../components/panels/audit-panel';

const TABS = [
  { id: 'approvals', label: 'Approvals' },
  { id: 'audit', label: 'Audit log' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function ActivityPage() {
  const [tab, setTab] = useState<TabId>('approvals');
  return (
    <div>
      <h1 className="page-title">Activity</h1>
      <p className="page-sub">
        Everything the platform does and asks of you — human approvals and the audit trail.
      </p>
      <div className="tabs" role="tablist" aria-label="Activity sections">
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
        {tab === 'approvals' ? <ApprovalsPanel hideHeader /> : <AuditPanel hideHeader />}
      </div>
    </div>
  );
}

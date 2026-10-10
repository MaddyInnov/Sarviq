// SPDX-License-Identifier: Apache-2.0
// CodingSessionStrip — Amoeba-style live session strip inside Chat: while a
// coding turn is active it shows the working agents (avatar, current file,
// progress), files touched, and pending approvals inline. Collapses away when
// no coding turn is active. NOT a top-level destination — lives in Chat.

'use client';

import React, { useMemo } from 'react';
import type { ToolCall } from '../../lib/api';
import type { CodeFileSession } from './useCodeSession';

export interface PendingApproval {
  approvalId: string;
  blockId: string;
  call: ToolCall;
}

export interface CodingSessionStripProps {
  files: CodeFileSession[];
  active: boolean;
  pendingApprovals: PendingApproval[];
  onDecide: (blockId: string, approvalId: string, decision: 'approved' | 'denied') => void;
  onOpenSession: () => void;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function CodingSessionStrip({
  files,
  active,
  pendingApprovals,
  onDecide,
  onOpenSession,
}: CodingSessionStripProps) {
  const agents = useMemo(() => {
    const byBot = new Map<string, { name: string; file: string; status: string }>();
    for (const f of files) {
      const key = f.botId || f.botName || 'agent';
      byBot.set(key, { name: f.botName || 'agent', file: f.file, status: f.status });
    }
    return [...byBot.values()];
  }, [files]);

  if (!active && files.length === 0) return null;
  if (!active) return null; // collapses away when no coding turn is active

  return (
    <div className="coding-strip" role="status" aria-label="Live coding session">
      <span className="cs-live-dot" aria-hidden="true" />
      <strong className="small">Coding</strong>
      <div className="coding-strip-agents">
        {agents.map((a, i) => (
          <span key={i} className="coding-agent-chip" title={`${a.name} — ${a.file}`}>
            <span className="coding-agent-avatar" aria-hidden="true">
              {(a.name || 'a').slice(0, 1).toUpperCase()}
            </span>
            <span className="mono small">{a.name || 'agent'}</span>
            <span className="muted small mono">{basename(a.file)}</span>
            <span className={`cs-status cs-st-${a.status === 'done' ? 'done' : 'writing'}`} aria-hidden="true" />
          </span>
        ))}
      </div>
      <button type="button" className="btn btn-sm" onClick={onOpenSession}>
        {files.length} file{files.length === 1 ? '' : 's'} — watch live
      </button>
      {pendingApprovals.length > 0 && (
        <div className="coding-strip-approvals">
          {pendingApprovals.map((p) => (
            <span key={p.approvalId} className="coding-approval-chip">
              <span className="mono small" title={JSON.stringify(p.call.args)}>
                {p.call.name}
              </span>
              <button type="button" className="btn btn-xs" onClick={() => onDecide(p.blockId, p.approvalId, 'approved')}>
                Approve
              </button>
              <button type="button" className="btn btn-xs btn-danger" onClick={() => onDecide(p.blockId, p.approvalId, 'denied')}>
                Deny
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

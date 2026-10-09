// SPDX-License-Identifier: Apache-2.0
'use client';

// Bulk triage for the Activity feed: keyboard shortcuts, a multi-select bulk
// actions bar, and a `?` shortcut help popover.
//
// Typing is never hijacked: the global keydown listener bails out whenever
// the event target is an editable control (input/textarea/select,
// contenteditable, textbox roles) or any modifier key is held.

import { useEffect } from 'react';
import {
  isEditableTarget,
  matchShortcut,
  TRIAGE_SHORTCUTS,
  type KeyTarget,
  type TriageAction,
} from '../../lib/shortcuts';

function targetOf(e: KeyboardEvent): KeyTarget {
  const t = e.target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!t || typeof t.tagName !== 'string') return {};
  return {
    tag: t.tagName,
    isContentEditable: Boolean(t.isContentEditable),
    role: t.getAttribute ? (t.getAttribute('role') ?? undefined) : undefined,
  };
}

export type TriageHandlers = Record<TriageAction, () => void>;

/**
 * Attach the feed shortcuts while `enabled`. `handlers` should be stable
 * (use refs / useCallback in the caller) to avoid re-binding on every render.
 */
export function useActivityShortcuts(enabled: boolean, handlers: TriageHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    const ref = { current: handlers };
    ref.current = handlers;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(targetOf(e))) return;
      const action = matchShortcut(e);
      if (!action) return;
      e.preventDefault();
      ref.current[action]();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, handlers]);
}

/** Bulk actions bar for the selected feed items. */
export function BulkBar({
  count,
  busy,
  onApprove,
  onDeny,
  onArchive,
  onClear,
}: {
  count: number;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onArchive: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk triage actions">
      <span className="small">
        <strong>{count}</strong> selected
      </span>
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={onApprove}>
        Mark done ({count})
      </button>
      <button className="btn btn-danger btn-sm" disabled={busy} onClick={onDeny}>
        Dismiss ({count})
      </button>
      <button className="btn btn-sm" disabled={busy} onClick={onArchive}>
        Archive ({count})
      </button>
      <button className="btn btn-sm" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

/** `?` shortcut help popover. */
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="shortcut-help-backdrop" onClick={onClose}>
      <div
        className="card shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between">
          <h4 className="mt0">Keyboard shortcuts</h4>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close shortcut help">
            ✕
          </button>
        </div>
        <table className="tbl">
          <tbody>
            {TRIAGE_SHORTCUTS.map((s) => (
              <tr key={s.key}>
                <td style={{ width: 90 }}>
                  <kbd className="kbd">{s.key}</kbd>
                </td>
                <td className="small">{s.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted mt">
          Shortcuts never fire while typing in an input, textarea, or other editable control,
          and never with Cmd / Ctrl / Alt held.
        </p>
      </div>
    </div>
  );
}

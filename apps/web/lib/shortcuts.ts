// SPDX-License-Identifier: Apache-2.0
// Pure keyboard-shortcut helpers for the Activity feed triage UI.
//
// Kept DOM-free on purpose: callers hand in a plain description of the event
// target so this module (and its tests) run in plain node. "Must not hijack
// typing" is enforced by `isEditableTarget` — callers check it before acting.

export type TriageAction =
  | 'refresh'
  | 'mark-done'
  | 'archive'
  | 'toggle-select'
  | 'focus-next'
  | 'focus-prev'
  | 'toggle-help'
  | 'clear-selection'
  | 'close';

/** Minimal description of an event target for editability checks. */
export interface KeyTarget {
  tag?: string;
  isContentEditable?: boolean;
  role?: string;
}

const EDITABLE_TAGS = new Set(['input', 'textarea', 'select', 'option']);

/** True when keystrokes belong to the control (typing, menus) — never hijack. */
export function isEditableTarget(t: KeyTarget | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  if (t.role === 'textbox' || t.role === 'combobox' || t.role === 'listbox') return true;
  return EDITABLE_TAGS.has((t.tag ?? '').toLowerCase());
}

export interface ShortcutDef {
  key: string;
  action: TriageAction;
  label: string;
}

export const TRIAGE_SHORTCUTS: ShortcutDef[] = [
  { key: 'r', action: 'refresh', label: 'Refresh the feed' },
  { key: 'd', action: 'mark-done', label: 'Mark done (approve) focused / selected items' },
  { key: 'a', action: 'archive', label: 'Archive focused / selected items' },
  { key: 'x', action: 'toggle-select', label: 'Select / deselect the focused item' },
  { key: 'j', action: 'focus-next', label: 'Move focus to next item' },
  { key: 'k', action: 'focus-prev', label: 'Move focus to previous item' },
  { key: 'Escape', action: 'close', label: 'Clear selection / close help' },
  { key: '?', action: 'toggle-help', label: 'Open / close this shortcut help' },
];

export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * Map a keydown to a triage action, or null. Modifier combos (Cmd/Ctrl/Alt)
 * are never intercepted — only plain single-key presses.
 */
export function matchShortcut(e: KeyEventLike): TriageAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const found = TRIAGE_SHORTCUTS.find((s) => s.key === e.key);
  return found ? found.action : null;
}

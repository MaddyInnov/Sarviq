// SPDX-License-Identifier: Apache-2.0
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface SwitcherNote {
  id: string;
  title: string;
}

interface Props {
  open: boolean;
  notes: SwitcherNote[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: (title: string) => void;
}

/** Simple fuzzy match: all query chars appear in order in the target. */
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/**
 * Cmd+K / Ctrl+K quick switcher: fuzzy-search notes, Enter opens,
 * or create a new note with the typed title.
 */
export function QuickSwitcher({ open, notes, onClose, onSelect, onCreate }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open ]);

  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return notes.slice(0, 8);
    return notes.filter((n) => fuzzyMatch(q, n.title)).slice(0, 8);
  }, [notes, query]);

  useEffect(() => setCursor(0), [matches.length]);

  if (!open) return null;

  const choose = (index: number): void => {
    const note = matches[index];
    if (note) {
      onSelect(note.id);
    } else if (query.trim()) {
      onCreate(query.trim());
    }
    onClose();
  };

  const exactExists = matches.some(
    (n) => n.title.toLowerCase() === query.trim().toLowerCase(),
  );

  return (
    <div
      className="qs-overlay"
      onClick={onClose}
      role="dialog"
      aria-label="Quick switcher"
    >
      <div className="qs-panel card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="input qs-input"
          placeholder="Type a note title… (Enter to open)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(cursor);
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        <div className="qs-list">
          {matches.map((n, i) => (
            <button
              key={n.id}
              className={`qs-item${i === cursor ? ' active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(i)}
            >
              <span className="truncate">{n.title}</span>
            </button>
          ))}
          {query.trim() && !exactExists && (
            <button
              className={`qs-item qs-create${matches.length === cursor ? ' active' : ''}`}
              onClick={() => {
                onCreate(query.trim());
                onClose();
              }}
            >
              <span className="truncate">+ Create “{query.trim()}”</span>
            </button>
          )}
          {matches.length === 0 && !query.trim() && (
            <div className="small muted qs-empty">No notes yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

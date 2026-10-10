// SPDX-License-Identifier: Apache-2.0
// CodeSessionView — Amoeba-style live code session: file tabs for everything
// the agent touches this turn, with the active edit streaming in as an
// animated diff (added lines glow green, removed lines strike red).
// - Character-level reveal on the active line, line stepping behind it.
// - Auto-scrolls to the active edit (until the user scrolls up).
// - Reduced-motion → instant full render, no animation loop.
// - Pauses the loop when scrolled out of view (Pet3D contract).
// - Reuses highlight.ts's lineDiff + tokenizer; no new highlighting code.

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { langFromPath, lineDiff, tokenize, type DiffLine, type Token } from './highlight';
import type { CodeFileSession } from './useCodeSession';

const TOKEN_CLASS: Record<Token['t'], string> = {
  keyword: 'tk-kw',
  string: 'tk-str',
  comment: 'tk-com',
  number: 'tk-num',
  punct: 'tk-punct',
  fn: 'tk-fn',
  plain: '',
};

function renderTokens(text: string, lang: string): React.ReactNode[] {
  return tokenize(text, lang).map((tok, i) =>
    tok.t === 'plain' ? (
      <React.Fragment key={i}>{tok.v}</React.Fragment>
    ) : (
      <span key={i} className={TOKEN_CLASS[tok.t]}>
        {tok.v}
      </span>
    ),
  );
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Plain pane for files the agent only read — no diff animation. */
function ReadPane({ file }: { file: CodeFileSession }) {
  const lang = useMemo(() => langFromPath(file.file), [file.file]);
  const lines = useMemo(() => file.after.split('\n'), [file.after]);
  return (
    <div className="code-session-diff" role="log" aria-label={`Content of ${file.file}`}>
      {lines.map((text, i) => (
        <div key={i} className="cs-line cs-same">
          <span className="cs-sign" aria-hidden="true">
            {' '}
          </span>
          <code>{renderTokens(text, lang)}</code>
        </div>
      ))}
    </div>
  );
}

/** One animated diff pane. Remount (via key) to replay for a rewritten file. */
function AnimatedDiff({
  file,
  onDone,
}: {
  file: CodeFileSession;
  onDone: (file: string) => void;
}) {
  const lang = useMemo(() => langFromPath(file.file), [file.file]);
  const diff: DiffLine[] = useMemo(() => lineDiff(file.before ?? '', file.after), [file.before, file.after]);
  const [progress, setProgress] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    doneRef.current = false;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || diff.length === 0) {
      setProgress(diff.length);
      return;
    }
    // Adaptive pacing: brisk but watchable; large writes cap at ~9s.
    const durationMs = Math.min(9000, Math.max(700, diff.length * 70));
    const rate = diff.length / durationMs; // lines per ms
    let raf = 0;
    let last = performance.now();
    let paused = false;
    let p = 0;
    const io = new IntersectionObserver(
      (entries) => {
        paused = !entries[0]?.isIntersecting;
        last = performance.now();
      },
      { threshold: 0.05 },
    );
    const el = wrapRef.current;
    if (el) io.observe(el);
    const step = (now: number) => {
      if (!paused) {
        p = Math.min(diff.length, p + (now - last) * rate);
        setProgress(p);
        if (p >= diff.length && !doneRef.current) {
          doneRef.current = true;
          onDoneRef.current(file.file);
        }
      }
      last = now;
      if (p < diff.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [diff, file.file]);

  // Auto-scroll to the active edit until the user scrolls up.
  useEffect(() => {
    const el = wrapRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [progress]);

  const fullLines = Math.floor(progress);
  const frac = progress - fullLines;

  return (
    <div
      ref={wrapRef}
      className="code-session-diff"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      role="log"
      aria-label={`Live diff for ${file.file}`}
    >
      {diff.slice(0, fullLines + 1).map((line, i) => {
        const isCurrent = i === fullLines && frac > 0 && frac < 1;
        const text = isCurrent ? line.text.slice(0, Math.max(1, Math.floor(line.text.length * frac))) : line.text;
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
        return (
          <div key={i} className={`cs-line cs-${line.kind}`}>
            <span className="cs-sign" aria-hidden="true">
              {sign}
            </span>
            <code>
              {renderTokens(text, lang)}
              {isCurrent && <span className="cs-caret" aria-hidden="true" />}
            </code>
          </div>
        );
      })}
    </div>
  );
}

export interface CodeSessionViewProps {
  files: CodeFileSession[];
  layout: 'inline' | 'side';
  onToggleLayout: () => void;
  onClose: () => void;
  onFileDone: (file: string) => void;
}

export function CodeSessionView({ files, layout, onToggleLayout, onClose, onFileDone }: CodeSessionViewProps) {
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const current = files.find((f) => f.file === activeFile) ?? files[files.length - 1] ?? null;
  // Follow the newest file while its edit is still streaming.
  const prevCount = useRef(files.length);
  useEffect(() => {
    if (files.length > prevCount.current) {
      const newest = files[files.length - 1]!;
      if (newest.status === 'writing') setActiveFile(newest.file);
    }
    prevCount.current = files.length;
  }, [files]);

  if (files.length === 0) return null;

  return (
    <section className={`code-session code-session-${layout}`} aria-label="Live code session">
      <header className="code-session-head">
        <span className="cs-live-dot" aria-hidden="true" />
        <strong>Live code session</strong>
        <span className="cs-count muted small">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={onToggleLayout} title={layout === 'inline' ? 'Pop out to side panel' : 'Dock inline'}>
          {layout === 'inline' ? '⤢ Side panel' : '⤡ Dock inline'}
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close code session">
          ✕
        </button>
      </header>
      <div className="cs-tabs" role="tablist" aria-label="Files touched this turn">
        {files.map((f) => (
          <button
            key={f.file}
            type="button"
            role="tab"
            aria-selected={current?.file === f.file}
            className={`cs-tab${current?.file === f.file ? ' active' : ''}`}
            onClick={() => setActiveFile(f.file)}
            title={`${f.file} — ${f.botName || 'agent'} (${f.status})`}
          >
            <span className={`cs-status cs-st-${f.status}`} aria-hidden="true" />
            <span className="cs-tab-name mono">{basename(f.file)}</span>
            {f.botName && <span className="cs-tab-bot">{f.botName}</span>}
          </button>
        ))}
      </div>
      {current &&
        (current.kind === 'read' ? (
          <ReadPane file={current} />
        ) : (
          <AnimatedDiff key={`${current.file}:${current.updatedAt}`} file={current} onDone={onFileDone} />
        ))}
    </section>
  );
}

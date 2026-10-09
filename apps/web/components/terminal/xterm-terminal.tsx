'use client';

// xterm.js terminal bound to a backend Terminal AI+ session.
// - keystrokes → POST /api/terminal/sessions/:id/input
// - output    ← EventSource /api/terminal/sessions/:id/stream
// Dynamically imported (no SSR) by the terminal page.

import { useEffect, useRef } from 'react';
import 'xterm/css/xterm.css';

interface Props {
  sessionId: string;
}

export default function XTermTerminal({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    let disposed = false;
    let term: { dispose: () => void } | null = null;
    let es: EventSource | null = null;
    let fit: { fit: () => void } | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('xterm'),
        import('xterm-addon-fit'),
      ]);
      if (disposed || !containerRef.current) return;

      const t = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: {
          background: '#14161f',
          foreground: '#e6e8f2',
          cursor: '#8b93ff',
          selectionBackground: 'rgba(139,147,255,0.3)',
          black: '#14161f',
          red: '#ff7a93',
          green: '#8ce8a0',
          yellow: '#ffd479',
          blue: '#8b93ff',
          magenta: '#c792ea',
          cyan: '#7dd7e8',
          white: '#e6e8f2',
        },
      });
      const fitAddon = new FitAddon();
      t.loadAddon(fitAddon);
      t.open(containerRef.current);
      fitAddon.fit();
      fit = fitAddon;
      term = t;
      t.focus();

      // Keystrokes → backend.
      t.onData((data: string) => {
        fetch(`/api/terminal/sessions/${sessionRef.current}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data }),
        }).catch(() => {
          // session may be closing; the stream will report it
        });
      });

      // Backend output → terminal.
      const source = new EventSource(`/api/terminal/sessions/${sessionRef.current}/stream`);
      es = source;
      source.onmessage = (ev: MessageEvent) => {
        try {
          const { chunk } = JSON.parse(ev.data) as { chunk: string };
          t.write(chunk);
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => {
        // Keep the terminal open; the session-close message arrives as data.
      };

      const onResize = () => {
        try {
          fitAddon.fit();
          const dims = fitAddon.proposeDimensions();
          if (dims) {
            fetch(`/api/terminal/sessions/${sessionRef.current}/resize`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ cols: dims.cols, rows: dims.rows }),
            }).catch(() => undefined);
          }
        } catch {
          // ignore
        }
      };
      window.addEventListener('resize', onResize);
      cleanupRef.current = () => window.removeEventListener('resize', onResize);
    })();

    return () => {
      disposed = true;
      try {
        cleanupRef.current?.();
      } catch {
        // ignore
      }
      try {
        es?.close();
      } catch {
        // ignore
      }
      try {
        term?.dispose();
      } catch {
        // ignore
      }
    };
    // Re-create the terminal when switching sessions (simplest correct
    // behavior: fresh PTY view per session tab).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return <div ref={containerRef} className="xterm-host" style={{ width: '100%', height: '100%' }} />;
}

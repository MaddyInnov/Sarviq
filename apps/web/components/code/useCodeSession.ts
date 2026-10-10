// SPDX-License-Identifier: Apache-2.0
// useCodeSession — derives a live "code session" from chat stream events.
// Tracks every file a bot touches this turn (read/write), the before/after
// for animated diffs, and whether a coding turn is in flight.
// Pure state logic (no DOM); the CodeSessionView component animates it.

'use client';

import { useCallback, useRef, useState } from 'react';
import type { StreamEvent, ToolCall } from '../../lib/api';

export type CodeFileStatus = 'reading' | 'writing' | 'done';

export interface CodeFileSession {
  file: string;
  botId: string;
  botName: string;
  kind: 'read' | 'write';
  before: string | null;
  /** For reads: file content (from tool_result). For writes: new content. */
  after: string;
  status: CodeFileStatus;
  callId: string;
  updatedAt: number;
}

export interface CodeSessionState {
  files: CodeFileSession[];
  /** True while a turn that touched code is in flight. */
  active: boolean;
}

const CODE_TOOLS = new Set(['write_file', 'read_file']);

function pathOf(call: ToolCall): string | null {
  const p = call.args?.path;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/**
 * Pure event transition (no React) — exported for unit tests.
 * `callFile` correlates tool_result back to its tab; mutated in place.
 */
export function applyCodeSessionEvent(
  prev: CodeSessionState,
  callFile: Map<string, string>,
  event: StreamEvent,
): CodeSessionState {
  if (event.type === 'tool_call' && CODE_TOOLS.has(event.call.name)) {
    const file = pathOf(event.call);
    if (!file) return prev;
    callFile.set(event.call.id, file);
    const kind = event.call.name === 'write_file' ? 'write' : 'read';
    const files = prev.files.filter((f) => f.file !== file);
    files.push({
      file,
      botId: '',
      botName: '',
      kind,
      before: null,
      after: '',
      status: kind === 'write' ? 'writing' : 'reading',
      callId: event.call.id,
      updatedAt: Date.now(),
    });
    return { files, active: true };
  }
  if (event.type === 'tool_result') {
    const file = callFile.get(event.call.id);
    if (!file) return prev;
    callFile.delete(event.call.id);
    // read_file's result IS the content; write_file's result is metadata
    // (the code_write event carries its before/after).
    if (typeof event.result === 'string') {
      const content = event.result.slice(0, 256 * 1024);
      return {
        ...prev,
        files: prev.files.map((f) =>
          f.file === file && f.kind === 'read'
            ? { ...f, after: content, status: 'done' as const, updatedAt: Date.now() }
            : f,
        ),
      };
    }
    return prev;
  }
  if (event.type === 'code_write') {
    const files = prev.files.filter((f) => f.file !== event.file);
    files.push({
      file: event.file,
      botId: event.botId,
      botName: event.botName,
      kind: 'write',
      before: event.before,
      after: event.after,
      status: 'writing',
      callId: event.call.id,
      updatedAt: Date.now(),
    });
    return { files, active: true };
  }
  if (event.type === 'done' || event.type === 'error' || event.type === 'interrupted') {
    callFile.clear();
    return prev.active ? { ...prev, active: false } : prev;
  }
  return prev;
}

export function useCodeSession() {
  const [state, setState] = useState<CodeSessionState>({ files: [], active: false });
  // callId -> file, to correlate tool_result back to its tab.
  const callFile = useRef(new Map<string, string>());

  const handleEvent = useCallback((event: StreamEvent) => {
    setState((prev) => applyCodeSessionEvent(prev, callFile.current, event));
  }, []);

  const markFileDone = useCallback((file: string) => {
    setState((prev) => ({
      ...prev,
      files: prev.files.map((f) => (f.file === file && f.status !== 'done' ? { ...f, status: 'done' } : f)),
    }));
  }, []);

  const reset = useCallback(() => {
    callFile.current.clear();
    setState({ files: [], active: false });
  }, []);

  return { files: state.files, active: state.active, handleEvent, markFileDone, reset };
}

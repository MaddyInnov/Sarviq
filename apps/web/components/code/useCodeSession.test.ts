// SPDX-License-Identifier: Apache-2.0
// Unit tests for the code-session event reducer (pure — no React/DOM).

import { describe, expect, it } from 'vitest';
import { applyCodeSessionEvent, type CodeSessionState } from './useCodeSession';
import type { StreamEvent, ToolCall } from '../../lib/api';

const EMPTY: CodeSessionState = { files: [], active: false };

function toolCall(id: string, name: string, path: string, extra: Record<string, unknown> = {}): ToolCall {
  return { id, name, args: { path, ...extra } };
}

function reduce(events: StreamEvent[]): { state: CodeSessionState; callFile: Map<string, string> } {
  const callFile = new Map<string, string>();
  let state = EMPTY;
  for (const e of events) state = applyCodeSessionEvent(state, callFile, e);
  return { state, callFile };
}

describe('applyCodeSessionEvent', () => {
  it('opens a writing tab on write_file tool_call and fills it on code_write', () => {
    const { state } = reduce([
      { type: 'tool_call', call: toolCall('c1', 'write_file', 'src/a.ts', { content: 'x' }), approvalRequired: false },
      {
        type: 'code_write', call: toolCall('c1', 'write_file', 'src/a.ts'), file: 'src/a.ts',
        before: null, after: 'const x = 1;\n', done: true, botId: 'b1', botName: 'Coder',
      },
    ]);
    expect(state.active).toBe(true);
    expect(state.files).toHaveLength(1);
    const f = state.files[0]!;
    expect(f.file).toBe('src/a.ts');
    expect(f.kind).toBe('write');
    expect(f.status).toBe('writing');
    expect(f.before).toBeNull();
    expect(f.after).toBe('const x = 1;\n');
    expect(f.botName).toBe('Coder');
  });

  it('tracks read_file tabs and fills content from tool_result', () => {
    const { state } = reduce([
      { type: 'tool_call', call: toolCall('c2', 'read_file', 'src/b.ts'), approvalRequired: false },
      { type: 'tool_result', call: toolCall('c2', 'read_file', 'src/b.ts'), result: 'hello\n' },
    ]);
    expect(state.files).toHaveLength(1);
    const f = state.files[0]!;
    expect(f.kind).toBe('read');
    expect(f.status).toBe('done');
    expect(f.after).toBe('hello\n');
  });

  it('rewriting the same file replaces the tab (no duplicates)', () => {
    const { state } = reduce([
      { type: 'tool_call', call: toolCall('c1', 'write_file', 'a.ts', { content: 'v1' }), approvalRequired: false },
      { type: 'code_write', call: toolCall('c1', 'write_file', 'a.ts'), file: 'a.ts', before: null, after: 'v1', done: true, botId: 'b', botName: 'B' },
      { type: 'tool_call', call: toolCall('c3', 'write_file', 'a.ts', { content: 'v2' }), approvalRequired: false },
      { type: 'code_write', call: toolCall('c3', 'write_file', 'a.ts'), file: 'a.ts', before: 'v1', after: 'v2', done: true, botId: 'b', botName: 'B' },
    ]);
    expect(state.files).toHaveLength(1);
    expect(state.files[0]!.after).toBe('v2');
    expect(state.files[0]!.before).toBe('v1');
  });

  it('ignores non-code tool calls and unknown tool_results', () => {
    const { state } = reduce([
      { type: 'tool_call', call: toolCall('c9', 'run_command', 'ignored', { command: 'ls' }), approvalRequired: false },
      { type: 'tool_result', call: toolCall('c9', 'run_command', 'x'), result: 'ok' },
    ]);
    expect(state.files).toHaveLength(0);
    expect(state.active).toBe(false);
  });

  it('deactivates on done/error/interrupted but keeps the files', () => {
    const { state } = reduce([
      { type: 'tool_call', call: toolCall('c1', 'write_file', 'a.ts', { content: 'v1' }), approvalRequired: false },
      { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    expect(state.active).toBe(false);
    expect(state.files).toHaveLength(1);
  });

  it('before/after survive for diffing an edit of an existing file', () => {
    const { state } = reduce([
      {
        type: 'code_write', call: toolCall('c1', 'write_file', 'a.ts'), file: 'a.ts',
        before: 'line1\nline2\n', after: 'line1\nline2 changed\n', done: true, botId: 'b', botName: 'B',
      },
    ]);
    const f = state.files[0]!;
    expect(f.before).toBe('line1\nline2\n');
    expect(f.after).toBe('line1\nline2 changed\n');
  });
});

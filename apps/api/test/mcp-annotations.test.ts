// SPDX-License-Identifier: Apache-2.0
// Tests for the read-only-assistant MCP connection class
// (apps/api/src/mcp-annotations.ts):
// - read-scoped tools pass through to the base provider
// - annotations.append is exposed and appends a pending annotation
// - write/egress tools are denied with write_denied
// - the tool list advertises read tools + annotations.append only
// No network; the base provider is a stub.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlatformToolDef, ToolProvider } from '@mvp/agent-runtime';
import { AnnotationStore } from '../src/annotations.js';
import { ANNOTATIONS_APPEND_TOOL, createReadOnlyAssistantProvider } from '../src/mcp-annotations.js';

const BASE_TOOLS: PlatformToolDef[] = [
  { name: 'read_file', description: 'Read a file.', parameters: {} },
  { name: 'list_memory', description: 'List memory.', parameters: {} },
  { name: 'write_file', description: 'Write a file.', parameters: {} },
  { name: 'run_command', description: 'Run a shell command.', parameters: {} },
  { name: 'fetch', description: 'Fetch a URL.', parameters: {} },
  { name: 'chat', description: 'Chat with a bot.', parameters: {} },
];

function stubBase(): { provider: ToolProvider; calls: string[] } {
  const calls: string[] = [];
  const provider: ToolProvider = {
    listTools: async () => BASE_TOOLS,
    callTool: async (name: string) => {
      calls.push(name);
      return { tool: name, data: 'measured-telemetry' };
    },
  };
  return { provider, calls };
}

describe('createReadOnlyAssistantProvider', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-annotations-'));
  });

  it('lists read tools plus annotations.append — never write/egress tools', async () => {
    const { provider } = stubBase();
    const wrapped = createReadOnlyAssistantProvider(provider, new AnnotationStore(dir));
    const names = (await wrapped.listTools()).map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('list_memory');
    expect(names).toContain(ANNOTATIONS_APPEND_TOOL);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('fetch');
    expect(names).not.toContain('chat'); // egress: always calls the cloud LLM
    // annotations.append carries a schema advertising the quarantine.
    const appendDef = (await wrapped.listTools()).find((t) => t.name === ANNOTATIONS_APPEND_TOOL)!;
    expect(appendDef.description).toMatch(/ONLY write/);
    expect(JSON.stringify(appendDef.parameters)).toMatch(/promise/);
  });

  it('passes read calls through to the base provider untouched', async () => {
    const { provider, calls } = stubBase();
    const wrapped = createReadOnlyAssistantProvider(provider, new AnnotationStore(dir));
    const result = await wrapped.callTool('read_file', { path: 'x' });
    expect(calls).toEqual(['read_file']);
    expect(result).toEqual({ tool: 'read_file', data: 'measured-telemetry' });
  });

  it('denies write and egress tools with write_denied', async () => {
    const { provider, calls } = stubBase();
    const wrapped = createReadOnlyAssistantProvider(provider, new AnnotationStore(dir));
    for (const tool of ['write_file', 'run_command', 'fetch', 'chat', 'memory_store']) {
      await expect(wrapped.callTool(tool, {})).rejects.toThrow(/write_denied/);
    }
    expect(calls).toEqual([]); // denied before the base provider ever runs
  });

  it('annotations.append stores a pending, labeled annotation in the annotations store', async () => {
    const { provider, calls } = stubBase();
    const store = new AnnotationStore(dir);
    const wrapped = createReadOnlyAssistantProvider(provider, store, { defaultSource: 'agent-x' });
    const result = (await wrapped.callTool(ANNOTATIONS_APPEND_TOOL, {
      kind: 'promise',
      content: 'will re-check the queue at 6pm',
    })) as { status: string; record: string; annotation: { id: string; status: string; source: string } };
    expect(result.status).toBe('ok');
    expect(result.record).toBe('annotation');
    expect(result.annotation.status).toBe('pending');
    expect(result.annotation.source).toBe('agent-x');
    expect(calls).toEqual([]); // never reached the base provider
    // It lives in the annotations store, queued for human review…
    expect(store.listPending()).toHaveLength(1);
    // …and nowhere else: the store file is annotations.json, not telemetry.
    expect(store.path()).toMatch(/annotations\.json$/);
  });

  it('annotations.append validates input like the REST route does', async () => {
    const { provider } = stubBase();
    const wrapped = createReadOnlyAssistantProvider(provider, new AnnotationStore(dir));
    await expect(wrapped.callTool(ANNOTATIONS_APPEND_TOOL, { kind: 'bogus', content: 'x' })).rejects.toThrow(/kind/);
    await expect(wrapped.callTool(ANNOTATIONS_APPEND_TOOL, { kind: 'note', content: '' })).rejects.toThrow(/content/);
  });

  it('honors an explicit source and does not leak the base tools list', async () => {
    const { provider } = stubBase();
    const store = new AnnotationStore(dir);
    const wrapped = createReadOnlyAssistantProvider(provider, store);
    const result = (await wrapped.callTool(ANNOTATIONS_APPEND_TOOL, {
      kind: 'note',
      content: 'saw this',
      source: 'claude-code-ext',
    })) as { annotation: { source: string } };
    expect(result.annotation.source).toBe('claude-code-ext');
  });
});

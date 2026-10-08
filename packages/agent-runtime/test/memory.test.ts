// SPDX-License-Identifier: Apache-2.0
// Tests for per-bot persistent memory:
// - BotMemoryStore: append/recall/replace round-trip, one file per bot,
//   dir auto-creation, path-traversal rejection on bot ids
// - createMemoryTools: memory_recall / memory_store honor ctx.botId.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotMemoryStore, createMemoryTools } from '../src/memory.js';
import type { ToolContext } from '../src/types.js';

let dir: string;
let store: BotMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-memory-'));
  store = new BotMemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (botId: string): ToolContext => ({ sessionId: 'sess-1', botId });

describe('BotMemoryStore', () => {
  it('reads empty when the bot has no memory yet', () => {
    expect(store.read('helper')).toBe('');
    expect(existsSync(join(dir, 'memories'))).toBe(false); // no dir created on read
  });

  it('append/recall round-trips timestamped entries', () => {
    store.append('helper', 'User prefers concise answers.');
    store.append('helper', 'Project: Sauda price comparison app.');
    const content = store.read('helper');
    expect(content).toContain('User prefers concise answers.');
    expect(content).toContain('Project: Sauda price comparison app.');
    // timestamped markdown sections
    expect(content.match(/^## \d{4}-\d{2}-\d{2}T/m)).not.toBeNull();
    expect(existsSync(join(dir, 'memories', 'helper.md'))).toBe(true);
  });

  it('keeps one file per bot', () => {
    store.append('bot-a', 'fact for A');
    store.append('bot-b', 'fact for B');
    expect(store.read('bot-a')).toContain('fact for A');
    expect(store.read('bot-a')).not.toContain('fact for B');
    expect(store.read('bot-b')).toContain('fact for B');
  });

  it('replace overwrites the whole file (user edits)', () => {
    store.append('helper', 'old fact');
    store.replace('helper', '# Memory\n\nNew curated content.\n');
    expect(store.read('helper')).toBe('# Memory\n\nNew curated content.\n');
  });

  it('rejects bot ids that could escape the memories dir', () => {
    for (const bad of ['../../etc/passwd', 'a/b', 'bot id', '', 'x'.repeat(65)]) {
      expect(() => store.read(bad)).toThrow(/Invalid bot id/);
      expect(() => store.append(bad, 'entry')).toThrow(/Invalid bot id/);
      expect(() => store.replace(bad, 'content')).toThrow(/Invalid bot id/);
    }
    // sanity: a legit id still works
    store.append('bot_ok-1', 'fine');
    expect(readFileSync(join(dir, 'memories', 'bot_ok-1.md'), 'utf8')).toContain('fine');
  });

  it('rejects empty entries on append', () => {
    expect(() => store.append('helper', '   ')).toThrow(/non-empty/);
  });
});

describe('createMemoryTools', () => {
  it('exposes memory_recall and memory_store with the documented schemas', () => {
    const tools = createMemoryTools({ store });
    expect(tools.map((t) => t.name)).toEqual(['memory_recall', 'memory_store']);
    const recall = tools[0]!;
    const storeTool = tools[1]!;
    expect((recall.parameters as { required?: string[] }).required ?? []).toEqual([]);
    expect((storeTool.parameters as { required: string[] }).required).toEqual(['entry']);
  });

  it('memory_store appends under ctx.botId and memory_recall reads it back', async () => {
    const tools = createMemoryTools({ store });
    const recall = tools[0]!;
    const storeTool = tools[1]!;

    const before = (await recall.handler({}, ctx('scout'))) as { content: string };
    expect(before.content).toBe('');

    const stored = (await storeTool.handler({ entry: 'Scout remembers this.' }, ctx('scout'))) as {
      stored: boolean;
    };
    expect(stored.stored).toBe(true);

    const after = (await recall.handler({}, ctx('scout'))) as { content: string };
    expect(after.content).toContain('Scout remembers this.');

    // other bots are unaffected
    const other = (await recall.handler({}, ctx('helper'))) as { content: string };
    expect(other.content).toBe('');
  });

  it('memory_store rejects an empty entry', async () => {
    const storeTool = createMemoryTools({ store })[1]!;
    await expect(storeTool.handler({ entry: '' }, ctx('helper'))).rejects.toThrow(/non-empty/);
  });
});

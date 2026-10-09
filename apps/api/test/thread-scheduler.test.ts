// SPDX-License-Identifier: Apache-2.0
// Tests for the routines→workflows link in apps/api/src/thread-scheduler.ts:
// 'workflow'-kind schedules start a workflow run on schedule (and the
// pre-existing 'bot-turn' behavior is unchanged). Fake runtime/governance;
// temp data dirs only.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import { ThreadScheduler, ThreadScheduleStore } from '../src/thread-scheduler.js';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mvp-sched-'));
}

const BOT: BotConfig = {
  id: 'helper',
  name: 'Helper',
  description: 'test',
  systemPrompt: 'test',
  provider: 'groq',
  model: 'gpt-oss-20b',
  skills: [],
  tools: [],
  mcpServers: [],
};

function cronFor(date: Date): string {
  return `${date.getMinutes()} ${date.getHours()} * * *`;
}

describe('ThreadScheduler workflow schedules', () => {
  let dir: string;
  let store: ThreadScheduleStore;

  beforeEach(() => {
    dir = freshDataDir();
    store = new ThreadScheduleStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('workflow schedules start a workflow run via the hook', async () => {
    const started: Array<{ workflowId: string; input: unknown }> = [];
    const wakes: Array<{ ok: boolean; error?: string }> = [];
    const scheduler = new ThreadScheduler({
      store,
      agentRuntime: {} as AgentRuntime,
      getBots: () => [BOT],
      startWorkflow: async (workflowId, input) => {
        started.push({ workflowId, input });
        return { id: 'run-1' };
      },
      onWake: (info) => wakes.push({ ok: info.ok, error: info.error }),
    });
    const s = store.create({
      botId: 'helper',
      sessionId: 'sess-1',
      cron: cronFor(new Date()),
      prompt: '',
      kind: 'workflow',
      workflowId: 'nightly-report',
      workflowInput: { day: 'today' },
    });
    expect(s.kind).toBe('workflow');
    expect(s.workflowId).toBe('nightly-report');
    await scheduler.tick(new Date());
    expect(started).toEqual([{ workflowId: 'nightly-report', input: { day: 'today' } }]);
    expect(wakes).toEqual([{ ok: true, error: undefined }]);
    scheduler.stop();
  });

  it('workflow schedule without a hook fails with a clear onWake error', async () => {
    const wakes: Array<{ ok: boolean; error?: string }> = [];
    const scheduler = new ThreadScheduler({
      store,
      agentRuntime: {} as AgentRuntime,
      getBots: () => [BOT],
      onWake: (info) => wakes.push({ ok: info.ok, error: info.error }),
    });
    store.create({
      botId: 'helper',
      sessionId: 'sess-1',
      cron: cronFor(new Date()),
      prompt: '',
      kind: 'workflow',
      workflowId: 'w',
    });
    await scheduler.tick(new Date());
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.ok).toBe(false);
    expect(wakes[0]!.error).toMatch(/startWorkflow/);
    scheduler.stop();
  });

  it('bot-turn schedules still wake threads (unchanged behavior)', async () => {
    const turns: string[] = [];
    const scheduler = new ThreadScheduler({
      store,
      agentRuntime: {
        runTurn: async (opts: { message: string }) => {
          turns.push(opts.message);
          return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
        },
      } as unknown as AgentRuntime,
      getBots: () => [BOT],
    });
    const s = store.create({ botId: 'helper', sessionId: 'sess-1', cron: cronFor(new Date()), prompt: 'wake up' });
    expect(s.kind).toBe('bot-turn');
    await scheduler.tick(new Date());
    expect(turns).toEqual(['wake up']);
    scheduler.stop();
  });

  it('validates workflow schedules at creation', () => {
    expect(() =>
      store.create({ botId: 'b', sessionId: 's', cron: '* * * * *', prompt: '', kind: 'workflow' }),
    ).toThrow(/workflowId is required/);
    expect(() =>
      store.create({ botId: 'b', sessionId: 's', cron: 'not a cron', prompt: 'x' }),
    ).toThrow(/cron must be/);
    expect(() =>
      store.create({ botId: 'b', sessionId: 's', cron: '* * * * *', prompt: '' }),
    ).toThrow(/prompt is required/);
  });

  it('migrates pre-existing databases (columns added idempotently)', () => {
    // Simulate an old DB without the new columns.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'thread-schedules.db'));
    db.exec('DROP TABLE IF EXISTS thread_schedules');
    db.exec(`CREATE TABLE thread_schedules (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, session_id TEXT NOT NULL,
      cron TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, last_fired_minute TEXT)`);
    db.prepare(
      `INSERT INTO thread_schedules (id, bot_id, session_id, cron, prompt, enabled, created_at)
       VALUES ('old-1', 'helper', 'sess-1', '* * * * *', 'hi', 1, 1)`,
    ).run();
    db.close();
    const migrated = new ThreadScheduleStore(dir);
    const all = migrated.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.kind).toBe('bot-turn'); // default for old rows
    expect(all[0]!.id).toBe('old-1');
  });
});

// SPDX-License-Identifier: Apache-2.0
// Thread automations — Codex-style "wake this conversation on a schedule".
//
// Cron triggers start *workflows*. Thread schedules wake *chat threads*: at
// the scheduled time, the scheduler runs an agent turn on the session with
// the wake prompt, and the session's history provides the conversation
// context. The user sees the agent's scheduled check-in when they open the
// thread.
//
// Storage: <dataDir>/thread-schedules.db (own file, same node:sqlite
// pattern as the workflow TriggerStore).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export interface ThreadSchedule {
  id: string;
  botId: string;
  sessionId: string;
  /** 5-field cron expression. */
  cron: string;
  /** The wake prompt sent as the scheduled message. */
  prompt: string;
  enabled: boolean;
  createdAt: number;
  lastFiredMinute?: string;
}

interface ThreadScheduleRow {
  id: string;
  bot_id: string;
  session_id: string;
  cron: string;
  prompt: string;
  enabled: number;
  created_at: number;
  last_fired_minute: string | null;
}

function rowToSchedule(r: ThreadScheduleRow): ThreadSchedule {
  return {
    id: r.id,
    botId: r.bot_id,
    sessionId: r.session_id,
    cron: r.cron,
    prompt: r.prompt,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastFiredMinute: r.last_fired_minute ?? undefined,
  };
}

const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

export function validateCron(expr: string): void {
  if (!CRON_RE.test(expr.trim())) {
    throw new Error('cron must be a 5-field expression: "minute hour dom month dow"');
  }
}

function cronMatches(expr: string, d: Date): boolean {
  const m = CRON_RE.exec(expr.trim());
  if (!m) return false;
  const [, minute, hour, dom, month, dow] = m;
  const match = (field: string, value: number): boolean => {
    if (field === '*') return true;
    return field.split(',').some((part) => {
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const s = Number(step);
        if (range === '*') return value % s === 0;
        return false;
      }
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        return value >= a && value <= b;
      }
      return Number(part) === value;
    });
  };
  return (
    match(minute, d.getMinutes()) &&
    match(hour, d.getHours()) &&
    match(dom, d.getDate()) &&
    match(month, d.getMonth() + 1) &&
    match(dow, d.getDay())
  );
}

export class ThreadScheduleStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'thread-schedules.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_schedules (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_fired_minute TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_thread_schedules_enabled ON thread_schedules(enabled);
    `);
  }

  create(input: { botId: string; sessionId: string; cron: string; prompt: string }): ThreadSchedule {
    validateCron(input.cron);
    if (!input.prompt.trim() || input.prompt.length > 4000) {
      throw new Error('prompt is required (max 4000 chars).');
    }
    const s: ThreadSchedule = {
      id: randomUUID(),
      botId: input.botId,
      sessionId: input.sessionId,
      cron: input.cron.trim(),
      prompt: input.prompt.trim(),
      enabled: true,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO thread_schedules (id, bot_id, session_id, cron, prompt, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      )
      .run(s.id, s.botId, s.sessionId, s.cron, s.prompt, s.createdAt);
    return s;
  }

  list(): ThreadSchedule[] {
    const rows = this.db.prepare('SELECT * FROM thread_schedules ORDER BY created_at DESC').all() as unknown as ThreadScheduleRow[];
    return rows.map(rowToSchedule);
  }

  get(id: string): ThreadSchedule | undefined {
    const row = this.db.prepare('SELECT * FROM thread_schedules WHERE id = ?').get(id) as unknown as ThreadScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  setEnabled(id: string, enabled: boolean): ThreadSchedule | undefined {
    this.db.prepare('UPDATE thread_schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    const r = this.db.prepare('DELETE FROM thread_schedules WHERE id = ?').run(id);
    return r.changes > 0;
  }

  markFired(id: string, minuteKey: string): void {
    this.db.prepare('UPDATE thread_schedules SET last_fired_minute = ? WHERE id = ?').run(minuteKey, id);
  }

  due(now: Date): ThreadSchedule[] {
    return this.list().filter(
      (s) => s.enabled && cronMatches(s.cron, now) && s.lastFiredMinute !== minuteKey(now),
    );
  }
}

function minuteKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

export interface ThreadSchedulerDeps {
  store: ThreadScheduleStore;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /** Called after a scheduled turn completes (e.g. to notify). */
  onWake?: (info: { schedule: ThreadSchedule; ok: boolean; error?: string }) => void;
  /**
   * Resolve a persistent E2B sandbox ID for a session (Dot environments).
   * When the session belongs to a Dot with a live environment, its turns
   * run `run_command` inside that sandbox.
   */
  getPersistentSandboxId?: (sessionId: string) => string | undefined;
}

/**
 * Ticks every minute; for each due schedule, runs an agent turn on the
 * session with the wake prompt. The session's stored history gives the
 * agent its conversation context.
 */
export class ThreadScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: ThreadSchedulerDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Fire once shortly after boot so a schedule due during downtime fires.
    setTimeout(() => void this.tick(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const key = minuteKey(now);
      for (const s of this.deps.store.due(now)) {
        this.deps.store.markFired(s.id, key);
        const bot = this.deps.getBots().find((b) => b.id === s.botId);
        if (!bot) {
          this.deps.onWake?.({ schedule: s, ok: false, error: `Unknown bot "${s.botId}"` });
          continue;
        }
        try {
          await this.deps.agentRuntime.runTurn({
            bot,
            message: s.prompt,
            sessionId: s.sessionId,
            persistentSandboxId: this.deps.getPersistentSandboxId?.(s.sessionId),
            onEvent: () => {},
          });
          this.deps.onWake?.({ schedule: s, ok: true });
        } catch (err) {
          this.deps.onWake?.({
            schedule: s,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

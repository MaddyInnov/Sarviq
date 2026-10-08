// SPDX-License-Identifier: Apache-2.0

import type { ChatMessage, RichMessage, ToolCall } from './types.js';

// vitest (Vite 5.4.21) cannot statically resolve the `node:sqlite` specifier,
// so load it at runtime via the builtin-module API instead of a top-level import.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

export interface SessionRecord {
  id: string;
  botId: string;
  createdAt: string;
}

interface MessageRow {
  role: string;
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
}

function newId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Default cap on messages returned by getMessages(). */
export const DEFAULT_HISTORY_LIMIT = 100;
/** Env var consulted when no explicit historyLimit is passed to the constructor. */
export const HISTORY_LIMIT_ENV_VAR = 'SESSION_HISTORY_LIMIT';

export interface SessionStoreOptions {
  /**
   * Max messages returned by getMessages(); older messages are dropped from
   * the result (the DB rows are kept). Must be a positive integer.
   * Precedence: constructor option > SESSION_HISTORY_LIMIT env var > 100.
   */
  historyLimit?: number;
}

function parseHistoryLimit(raw: string | number | undefined): number | undefined {
  const n = typeof raw === 'number' ? raw : raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined;
}

/**
 * SQLite-backed session + message store (node:sqlite, no native deps).
 * Assistant tool calls are persisted in a JSON column so history can be
 * re-serialized for providers; the public ChatMessage contract is unchanged.
 *
 * Rolling window: getMessages() returns at most `historyLimit` most recent
 * messages (default 100, configurable via constructor option or the
 * SESSION_HISTORY_LIMIT env var). A console warning is emitted when
 * truncation kicks in, so unbounded context growth is visible, not silent.
 */
export class SessionStore {
  private readonly db: DatabaseSyncType;
  private readonly historyLimit: number;

  constructor(dbPath: string, opts: SessionStoreOptions = {}) {
    this.db = new DatabaseSync(dbPath);
    this.historyLimit =
      parseHistoryLimit(opts.historyLimit) ??
      parseHistoryLimit(process.env[HISTORY_LIMIT_ENV_VAR]) ??
      DEFAULT_HISTORY_LIMIT;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, id);
    `);
  }

  createSession(botId: string): string {
    const id = newId();
    this.db
      .prepare('INSERT INTO sessions (id, bot_id, created_at) VALUES (?, ?, ?)')
      .run(id, botId, new Date().toISOString());
    return id;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT id, bot_id AS botId, created_at AS createdAt FROM sessions WHERE id = ?')
      .get(id) as { id: string; botId: string; createdAt: string } | undefined;
    return row ? { id: row.id, botId: row.botId, createdAt: row.createdAt } : undefined;
  }

  appendMessage(sessionId: string, msg: ChatMessage): void {
    const rich = msg as RichMessage;
    const toolCalls: ToolCall[] | undefined = rich.toolCalls;
    this.db
      .prepare(
        'INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, tool_calls, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        sessionId,
        msg.role,
        msg.content,
        msg.toolName ?? null,
        msg.toolCallId ?? null,
        toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
        new Date().toISOString(),
      );
  }

  getMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        'SELECT role, content, tool_name, tool_call_id, tool_calls FROM messages WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId) as unknown as MessageRow[];
    const mapped = rows.map((row) => {
      const msg: RichMessage = {
        role: row.role as ChatMessage['role'],
        content: row.content,
      };
      if (row.tool_name) msg.toolName = row.tool_name;
      if (row.tool_call_id) msg.toolCallId = row.tool_call_id;
      if (row.tool_calls) {
        try {
          msg.toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
        } catch {
          // corrupted column: drop it rather than failing the whole history
        }
      }
      return msg;
    });
    if (mapped.length > this.historyLimit) {
      const dropped = mapped.length - this.historyLimit;
      console.warn(
        `[sessions] session ${sessionId}: history truncated, dropped ${dropped} of ${mapped.length} messages (limit ${this.historyLimit})`,
      );
      return mapped.slice(-this.historyLimit);
    }
    return mapped;
  }

  close(): void {
    this.db.close();
  }
}

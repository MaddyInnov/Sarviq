// SPDX-License-Identifier: Apache-2.0
// Side chats (Muse parity): separate persistent conversations with their own
// sqlite tables, fully independent of the main agent sessions. Each thread
// has a title and an ordered message list (user / assistant / system).

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type ThreadRole = 'user' | 'assistant' | 'system';

export interface SideThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: ThreadRole;
  content: string;
  createdAt: number;
}

interface ThreadRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: number;
}

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system']);

function rowToThread(row: ThreadRow): SideThread {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function rowToMessage(row: MessageRow): ThreadMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as ThreadRole,
    content: row.content,
    createdAt: row.created_at,
  };
}

export class ThreadStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: { title?: string } = {}): SideThread {
    const title = (input.title ?? '').trim() || 'Untitled thread';
    if (title.length > 200) throw new ValidationError('thread "title" must be at most 200 characters');
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare('INSERT INTO mm_threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, now, now);
    return this.getThread(id);
  }

  private getThread(id: string): SideThread {
    const row = this.mdb.db
      .prepare('SELECT id, title, created_at, updated_at FROM mm_threads WHERE id = ?')
      .get(id) as ThreadRow | undefined;
    if (!row) throw new NotFoundError(`unknown thread: ${id}`);
    return rowToThread(row);
  }

  /** Thread plus its messages (oldest first). */
  get(id: string): { thread: SideThread; messages: ThreadMessage[] } {
    return { thread: this.getThread(id), messages: this.messages(id) };
  }

  list(): SideThread[] {
    const rows = this.mdb.db
      .prepare('SELECT id, title, created_at, updated_at FROM mm_threads ORDER BY updated_at DESC')
      .all() as unknown as unknown as ThreadRow[];
    return rows.map(rowToThread);
  }

  rename(id: string, title: string): SideThread {
    this.getThread(id);
    const t = (title ?? '').trim();
    if (!t) throw new ValidationError('thread "title" must be a non-empty string');
    if (t.length > 200) throw new ValidationError('thread "title" must be at most 200 characters');
    this.mdb.db.prepare('UPDATE mm_threads SET title = ?, updated_at = ? WHERE id = ?').run(t, Date.now(), id);
    return this.getThread(id);
  }

  remove(id: string): void {
    this.getThread(id);
    this.mdb.db.prepare('DELETE FROM mm_thread_messages WHERE thread_id = ?').run(id);
    this.mdb.db.prepare('DELETE FROM mm_threads WHERE id = ?').run(id);
  }

  addMessage(threadId: string, role: ThreadRole, content: string): ThreadMessage {
    this.getThread(threadId);
    if (!ROLES.has(role)) {
      throw new ValidationError('message "role" must be one of: user, assistant, system');
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new ValidationError('message "content" must be a non-empty string');
    }
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) {
      throw new ValidationError('message "content" exceeds the 256 KiB limit');
    }
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        'INSERT INTO mm_thread_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, threadId, role, content, now);
    this.mdb.db.prepare('UPDATE mm_threads SET updated_at = ? WHERE id = ?').run(now, threadId);
    return { id, threadId, role, content, createdAt: now };
  }

  messages(threadId: string): ThreadMessage[] {
    this.getThread(threadId);
    const rows = this.mdb.db
      .prepare(
        'SELECT id, thread_id, role, content, created_at FROM mm_thread_messages WHERE thread_id = ? ORDER BY created_at ASC',
      )
      .all(threadId) as unknown as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }
}

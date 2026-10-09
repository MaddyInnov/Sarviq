// SPDX-License-Identifier: Apache-2.0
// Commitment tracking (Muse parity, P3-E): explicit "I will do X by Y"
// promises with due dates, outcomes, and optional links to a goal and/or a
// reminder (so the reminder fires and the commitment records what happened).
//
// A commitment is *open* until it is resolved as kept / missed or cancelled.
// listOverdue() finds open commitments whose due time has passed — the host
// (or an agent turn) uses it to nudge the user and record the outcome.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type CommitmentStatus = 'open' | 'kept' | 'missed' | 'cancelled';

export interface Commitment {
  id: string;
  title: string;
  detail: string;
  /** Due time, ms epoch; null when no deadline. */
  dueAt: number | null;
  /** Optional goal this commitment serves. */
  goalId: string | null;
  /** Optional reminder id wired to fire at the due time. */
  reminderId: string | null;
  status: CommitmentStatus;
  /** Free-text outcome recorded at resolution (e.g. "shipped v1.2"). */
  outcome: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface CreateCommitmentInput {
  title: string;
  detail?: string;
  /** ms epoch; optional. */
  dueAt?: number;
  goalId?: string;
  reminderId?: string;
}

interface CommitmentRow {
  id: string;
  title: string;
  detail: string;
  due_at: number | null;
  goal_id: string | null;
  reminder_id: string | null;
  status: string;
  outcome: string;
  created_at: number;
  resolved_at: number | null;
}

function rowToCommitment(row: CommitmentRow): Commitment {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    dueAt: row.due_at,
    goalId: row.goal_id,
    reminderId: row.reminder_id,
    status: row.status as CommitmentStatus,
    outcome: row.outcome,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

const STATUSES: ReadonlySet<string> = new Set(['open', 'kept', 'missed', 'cancelled']);

export class CommitmentStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: CreateCommitmentInput): Commitment {
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('commitment "title" must be a non-empty string');
    if (title.length > 200) throw new ValidationError('commitment "title" must be at most 200 characters');
    const detail = (input.detail ?? '').trim().slice(0, 2000);
    let dueAt: number | null = null;
    if (input.dueAt !== undefined && input.dueAt !== null) {
      if (!Number.isFinite(input.dueAt) || input.dueAt <= 0) {
        throw new ValidationError('commitment "dueAt" must be a ms-epoch timestamp');
      }
      dueAt = Math.floor(input.dueAt);
    }
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_commitments
           (id, title, detail, due_at, goal_id, reminder_id, status, outcome, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', '', ?, NULL)`,
      )
      .run(id, title, detail, dueAt, input.goalId ?? null, input.reminderId ?? null, now);
    return this.get(id);
  }

  get(id: string): Commitment {
    const row = this.mdb.db
      .prepare(
        `SELECT id, title, detail, due_at, goal_id, reminder_id, status, outcome, created_at, resolved_at
         FROM mm_commitments WHERE id = ?`,
      )
      .get(id) as unknown as CommitmentRow | undefined;
    if (!row) throw new NotFoundError(`unknown commitment: ${id}`);
    return rowToCommitment(row);
  }

  list(status?: CommitmentStatus): Commitment[] {
    if (status !== undefined && !STATUSES.has(status)) {
      throw new ValidationError(`commitment status must be one of: ${[...STATUSES].join(', ')}`);
    }
    const rows = (
      status
        ? this.mdb.db
            .prepare(
              `SELECT id, title, detail, due_at, goal_id, reminder_id, status, outcome, created_at, resolved_at
               FROM mm_commitments WHERE status = ? ORDER BY created_at DESC`,
            )
            .all(status)
        : this.mdb.db
            .prepare(
              `SELECT id, title, detail, due_at, goal_id, reminder_id, status, outcome, created_at, resolved_at
               FROM mm_commitments ORDER BY created_at DESC`,
            )
            .all()
    ) as unknown as unknown as CommitmentRow[];
    return rows.map(rowToCommitment);
  }

  /** Open commitments whose due time has passed (null dueAt never overdue). */
  listOverdue(now: number = Date.now()): Commitment[] {
    const rows = this.mdb.db
      .prepare(
        `SELECT id, title, detail, due_at, goal_id, reminder_id, status, outcome, created_at, resolved_at
         FROM mm_commitments
         WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ?
         ORDER BY due_at ASC`,
      )
      .all(Math.floor(now)) as unknown as unknown as CommitmentRow[];
    return rows.map(rowToCommitment);
  }

  /**
   * Resolve an open commitment. `kept` = done as promised, `missed` = not
   * done; either way the free-text outcome says what actually happened.
   */
  resolve(id: string, status: 'kept' | 'missed', outcome = ''): Commitment {
    if (status !== 'kept' && status !== 'missed') {
      throw new ValidationError('commitment resolution must be "kept" or "missed"');
    }
    const c = this.get(id);
    if (c.status !== 'open') {
      throw new ValidationError(`cannot resolve commitment in status "${c.status}"`);
    }
    const now = Date.now();
    this.mdb.db
      .prepare('UPDATE mm_commitments SET status = ?, outcome = ?, resolved_at = ? WHERE id = ?')
      .run(status, outcome.trim().slice(0, 1000), now, id);
    return this.get(id);
  }

  cancel(id: string): Commitment {
    const c = this.get(id);
    if (c.status !== 'open') {
      throw new ValidationError(`cannot cancel commitment in status "${c.status}"`);
    }
    const now = Date.now();
    this.mdb.db
      .prepare(`UPDATE mm_commitments SET status = 'cancelled', resolved_at = ? WHERE id = ?`)
      .run(now, id);
    return this.get(id);
  }

  /**
   * Link an existing reminder to an open commitment (e.g. created
   * separately via /reminders). Returns the updated commitment.
   */
  linkReminder(id: string, reminderId: string): Commitment {
    const c = this.get(id);
    if (c.status !== 'open') {
      throw new ValidationError(`cannot link a reminder to a commitment in status "${c.status}"`);
    }
    if (!reminderId || typeof reminderId !== 'string') {
      throw new ValidationError('reminderId must be a non-empty string');
    }
    this.mdb.db.prepare('UPDATE mm_commitments SET reminder_id = ? WHERE id = ?').run(reminderId, id);
    return this.get(id);
  }
}

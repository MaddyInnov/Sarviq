// SPDX-License-Identifier: Apache-2.0
// User goals with progress tracking (Muse parity): create / list / update
// progress (0–100, appends a history entry) / complete. Progress history is
// queryable per goal. Reaching 100% auto-completes the goal.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type GoalStatus = 'active' | 'completed';

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  /** 0–100. */
  progress: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalProgressEntry {
  id: string;
  goalId: string;
  pct: number;
  note: string;
  createdAt: number;
}

interface GoalRow {
  id: string;
  title: string;
  description: string;
  status: string;
  progress: number;
  created_at: number;
  updated_at: number;
}

interface ProgressRow {
  id: string;
  goal_id: string;
  pct: number;
  note: string;
  created_at: number;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as GoalStatus,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEntry(row: ProgressRow): GoalProgressEntry {
  return {
    id: row.id,
    goalId: row.goal_id,
    pct: row.pct,
    note: row.note,
    createdAt: row.created_at,
  };
}

export class GoalStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: { title: string; description?: string }): Goal {
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('goal "title" must be a non-empty string');
    if (title.length > 200) throw new ValidationError('goal "title" must be at most 200 characters');
    const description = (input.description ?? '').trim();
    if (description.length > 2000) {
      throw new ValidationError('goal "description" must be at most 2000 characters');
    }
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_goals (id, title, description, status, progress, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, ?)`,
      )
      .run(id, title, description, now, now);
    // Seed history with the 0% starting point so history() is never empty.
    this.mdb.db
      .prepare('INSERT INTO mm_goal_progress (id, goal_id, pct, note, created_at) VALUES (?, ?, 0, ?, ?)')
      .run(randomUUID(), id, 'goal created', now);
    return this.get(id);
  }

  get(id: string): Goal {
    const row = this.mdb.db
      .prepare('SELECT id, title, description, status, progress, created_at, updated_at FROM mm_goals WHERE id = ?')
      .get(id) as GoalRow | undefined;
    if (!row) throw new NotFoundError(`unknown goal: ${id}`);
    return rowToGoal(row);
  }

  list(status?: GoalStatus): Goal[] {
    const rows = (
      status
        ? this.mdb.db
            .prepare(
              'SELECT id, title, description, status, progress, created_at, updated_at FROM mm_goals WHERE status = ? ORDER BY updated_at DESC',
            )
            .all(status)
        : this.mdb.db
            .prepare(
              'SELECT id, title, description, status, progress, created_at, updated_at FROM mm_goals ORDER BY updated_at DESC',
            )
            .all()
    ) as unknown as GoalRow[];
    return rows.map(rowToGoal);
  }

  /**
   * Record progress. Appends a history entry; `pct` must be 0–100.
   * Reaching 100 auto-completes the goal.
   */
  updateProgress(id: string, pct: number, note = ''): Goal {
    const goal = this.get(id);
    if (goal.status === 'completed') {
      throw new ValidationError('goal is already completed');
    }
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      throw new ValidationError('progress "pct" must be an integer 0–100');
    }
    if (pct < goal.progress) {
      throw new ValidationError(
        `progress cannot move backwards (${goal.progress}% → ${pct}%)`,
      );
    }
    const now = Date.now();
    const status: GoalStatus = pct === 100 ? 'completed' : 'active';
    this.mdb.db
      .prepare('UPDATE mm_goals SET progress = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(pct, status, now, id);
    this.mdb.db
      .prepare('INSERT INTO mm_goal_progress (id, goal_id, pct, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), id, pct, note.trim().slice(0, 500), now);
    return this.get(id);
  }

  complete(id: string): Goal {
    const goal = this.get(id);
    if (goal.status === 'completed') return goal;
    return this.updateProgress(id, 100, 'marked complete');
  }

  /** Progress history, oldest first. */
  history(id: string): GoalProgressEntry[] {
    this.get(id); // throws NotFoundError for unknown goals
    const rows = this.mdb.db
      .prepare(
        'SELECT id, goal_id, pct, note, created_at FROM mm_goal_progress WHERE goal_id = ? ORDER BY created_at ASC',
      )
      .all(id) as unknown as unknown as ProgressRow[];
    return rows.map(rowToEntry);
  }
}

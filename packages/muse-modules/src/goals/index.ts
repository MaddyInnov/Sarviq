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

// ---------------------------------------------------------------------------
// Milestones (P3-E): ordered checklist items inside a goal. Completing the
// last open milestone auto-completes the goal (progress → 100 with a history
// entry), so a goal can be driven entirely by its milestones.
// ---------------------------------------------------------------------------

export interface GoalMilestone {
  id: string;
  goalId: string;
  title: string;
  position: number;
  done: boolean;
  createdAt: number;
  completedAt: number | null;
}

export interface GoalWithMilestones extends Goal {
  milestones: GoalMilestone[];
  milestonesDone: number;
  milestonesTotal: number;
}

interface MilestoneRow {
  id: string;
  goal_id: string;
  title: string;
  position: number;
  done: number;
  created_at: number;
  completed_at: number | null;
}

function rowToMilestone(row: MilestoneRow): GoalMilestone {
  return {
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    position: row.position,
    done: row.done === 1,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function checkMilestoneTitle(title: unknown): string {
  const t = (title ?? '').toString().trim();
  if (!t) throw new ValidationError('milestone "title" must be a non-empty string');
  if (t.length > 200) throw new ValidationError('milestone "title" must be at most 200 characters');
  return t;
}

export class GoalMilestoneStore {
  constructor(private readonly mdb: ModuleDb) {}

  /** Add a milestone to an active goal. Positions are assigned in order. */
  add(goalId: string, input: { title: string }): GoalMilestone {
    const title = checkMilestoneTitle(input.title);
    const goals = new GoalStore(this.mdb);
    const goal = goals.get(goalId); // throws NotFoundError for unknown goals
    if (goal.status !== 'active') {
      throw new ValidationError('cannot add milestones to a completed goal');
    }
    const maxPos = this.mdb.db
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM mm_goal_milestones WHERE goal_id = ?')
      .get(goalId) as unknown as { m: number };
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_goal_milestones (id, goal_id, title, position, done, created_at, completed_at)
         VALUES (?, ?, ?, ?, 0, ?, NULL)`,
      )
      .run(id, goalId, title, maxPos.m + 1, now);
    return this.getMilestone(id);
  }

  getMilestone(id: string): GoalMilestone {
    const row = this.mdb.db
      .prepare(
        'SELECT id, goal_id, title, position, done, created_at, completed_at FROM mm_goal_milestones WHERE id = ?',
      )
      .get(id) as unknown as MilestoneRow | undefined;
    if (!row) throw new NotFoundError(`unknown milestone: ${id}`);
    return rowToMilestone(row);
  }

  /** Milestones for a goal, in order. */
  list(goalId: string): GoalMilestone[] {
    new GoalStore(this.mdb).get(goalId); // throws NotFoundError for unknown goals
    const rows = this.mdb.db
      .prepare(
        `SELECT id, goal_id, title, position, done, created_at, completed_at
         FROM mm_goal_milestones WHERE goal_id = ? ORDER BY position ASC`,
      )
      .all(goalId) as unknown as unknown as MilestoneRow[];
    return rows.map(rowToMilestone);
  }

  /**
   * Mark a milestone done. When every milestone of the goal is done, the
   * goal itself is completed (progress → 100) with a history entry.
   */
  complete(goalId: string, milestoneId: string): { milestone: GoalMilestone; goal: Goal } {
    const goals = new GoalStore(this.mdb);
    goals.get(goalId);
    const m = this.getMilestone(milestoneId);
    if (m.goalId !== goalId) throw new ValidationError('milestone does not belong to this goal');
    if (m.done) return { milestone: m, goal: goals.get(goalId) };
    const now = Date.now();
    this.mdb.db
      .prepare('UPDATE mm_goal_milestones SET done = 1, completed_at = ? WHERE id = ?')
      .run(now, milestoneId);
    const open = this.mdb.db
      .prepare('SELECT COUNT(*) AS c FROM mm_goal_milestones WHERE goal_id = ? AND done = 0')
      .get(goalId) as unknown as { c: number };
    let goal = goals.get(goalId);
    if (open.c === 0 && goal.status === 'active') {
      // All milestones done → the goal is done. Drive it through
      // updateProgress so the history entry is recorded.
      goal = goals.updateProgress(goalId, 100, 'all milestones complete');
    }
    return { milestone: this.getMilestone(milestoneId), goal };
  }

  /** Goal plus its milestones and done/total counts. */
  detail(goalId: string): GoalWithMilestones {
    const goal = new GoalStore(this.mdb).get(goalId);
    const milestones = this.list(goalId);
    return {
      ...goal,
      milestones,
      milestonesDone: milestones.filter((m) => m.done).length,
      milestonesTotal: milestones.length,
    };
  }
}

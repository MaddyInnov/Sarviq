// SPDX-License-Identifier: Apache-2.0
// Idea cards (Muse parity): create / list / run / dismiss, with status
// tracking. Lifecycle: new → active (run) → done (complete); new/active →
// dismissed. Dismissed ideas can be re-run.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type IdeaStatus = 'new' | 'active' | 'done' | 'dismissed';

export interface Idea {
  id: string;
  title: string;
  description: string;
  status: IdeaStatus;
  createdAt: number;
  updatedAt: number;
}

interface IdeaRow {
  id: string;
  title: string;
  description: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function rowToIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as IdeaStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class IdeaStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: { title: string; description?: string }): Idea {
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('idea "title" must be a non-empty string');
    if (title.length > 200) throw new ValidationError('idea "title" must be at most 200 characters');
    const description = (input.description ?? '').trim();
    if (description.length > 2000) {
      throw new ValidationError('idea "description" must be at most 2000 characters');
    }
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_ideas (id, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, 'new', ?, ?)`,
      )
      .run(id, title, description, now, now);
    return this.get(id);
  }

  get(id: string): Idea {
    const row = this.mdb.db
      .prepare('SELECT id, title, description, status, created_at, updated_at FROM mm_ideas WHERE id = ?')
      .get(id) as IdeaRow | undefined;
    if (!row) throw new NotFoundError(`unknown idea: ${id}`);
    return rowToIdea(row);
  }

  list(status?: IdeaStatus): Idea[] {
    const rows = (
      status
        ? this.mdb.db
            .prepare(
              'SELECT id, title, description, status, created_at, updated_at FROM mm_ideas WHERE status = ? ORDER BY updated_at DESC',
            )
            .all(status)
        : this.mdb.db
            .prepare(
              'SELECT id, title, description, status, created_at, updated_at FROM mm_ideas ORDER BY updated_at DESC',
            )
            .all()
    ) as unknown as IdeaRow[];
    return rows.map(rowToIdea);
  }

  private transition(id: string, to: IdeaStatus, from: ReadonlySet<IdeaStatus>): Idea {
    const idea = this.get(id);
    if (!from.has(idea.status)) {
      throw new ValidationError(`cannot move idea from "${idea.status}" to "${to}"`);
    }
    const now = Date.now();
    this.mdb.db.prepare('UPDATE mm_ideas SET status = ?, updated_at = ? WHERE id = ?').run(to, now, id);
    return this.get(id);
  }

  /** Start (or re-start) working an idea. */
  run(id: string): Idea {
    return this.transition(id, 'active', new Set(['new', 'dismissed']));
  }

  /** Shelve an idea without deleting it. */
  dismiss(id: string): Idea {
    return this.transition(id, 'dismissed', new Set(['new', 'active']));
  }

  /** Mark a running idea finished. */
  complete(id: string): Idea {
    return this.transition(id, 'done', new Set(['active']));
  }
}

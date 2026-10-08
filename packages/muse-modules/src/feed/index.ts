// SPDX-License-Identifier: Apache-2.0
// Persistent proactive Feed (Muse parity).
//
// - The user writes a *brief* (stored, editable) describing what the feed
//   should cover.
// - A generator (FeedGenerator interface) produces posts from the brief.
//   MockFeedGenerator is deterministic and offline; swap in a real LLM-backed
//   generator for production.
// - Background scheduling: scheduleFeedGeneration() registers a cron trigger
//   in the existing workflows TriggerStore (imported, never edited); the
//   host's Scheduler + a workflow/runner hook then calls generateFeedPosts().

import { randomUUID } from 'node:crypto';
import type { Trigger, TriggerStore } from '@mvp/workflows';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export interface FeedBrief {
  brief: string;
  updatedAt: number;
}

export interface FeedPost {
  id: string;
  title: string;
  body: string;
  sourceNote: string | null;
  dismissed: boolean;
  createdAt: number;
}

export interface FeedPostDraft {
  title: string;
  body: string;
  sourceNote?: string;
}

interface FeedPostRow {
  id: string;
  title: string;
  body: string;
  source_note: string | null;
  dismissed: number;
  created_at: number;
}

function rowToPost(row: FeedPostRow): FeedPost {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    sourceNote: row.source_note,
    dismissed: row.dismissed === 1,
    createdAt: row.created_at,
  };
}

export class FeedStore {
  constructor(private readonly mdb: ModuleDb) {}

  /** The stored brief, or null when the user has not written one yet. */
  getBrief(): FeedBrief | null {
    const row = this.mdb.db
      .prepare('SELECT brief, updated_at AS updatedAt FROM mm_feed_brief WHERE id = 1')
      .get() as { brief: string; updatedAt: number } | undefined;
    return row ? { brief: row.brief, updatedAt: row.updatedAt } : null;
  }

  /** Replace the stored brief. The brief is user content, never a secret. */
  setBrief(brief: string): FeedBrief {
    if (typeof brief !== 'string' || !brief.trim()) {
      throw new ValidationError('feed brief must be a non-empty string');
    }
    if (brief.trim().length > 5000) {
      throw new ValidationError('feed brief must be at most 5000 characters');
    }
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_feed_brief (id, brief, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET brief = excluded.brief, updated_at = excluded.updated_at`,
      )
      .run(brief.trim(), now);
    return { brief: brief.trim(), updatedAt: now };
  }

  listPosts(includeDismissed = false): FeedPost[] {
    const rows = this.mdb.db
      .prepare(
        `SELECT id, title, body, source_note, dismissed, created_at
         FROM mm_feed_posts ${includeDismissed ? '' : 'WHERE dismissed = 0 '}
         ORDER BY created_at DESC`,
      )
      .all() as unknown as unknown as FeedPostRow[];
    return rows.map(rowToPost);
  }

  addPost(draft: FeedPostDraft): FeedPost {
    const title = (draft.title ?? '').trim();
    if (!title) throw new ValidationError('feed post title must be non-empty');
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        'INSERT INTO mm_feed_posts (id, title, body, source_note, dismissed, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      )
      .run(id, title, draft.body ?? '', draft.sourceNote ?? null, now);
    const post = this.getPost(id);
    if (!post) throw new Error('FeedStore.addPost: failed to read back inserted post');
    return post;
  }

  getPost(id: string): FeedPost | null {
    const row = this.mdb.db
      .prepare('SELECT id, title, body, source_note, dismissed, created_at FROM mm_feed_posts WHERE id = ?')
      .get(id) as FeedPostRow | undefined;
    return row ? rowToPost(row) : null;
  }

  /** Dismiss a post (soft-delete; kept for audit, hidden from the feed). */
  dismissPost(id: string): FeedPost {
    const existing = this.getPost(id);
    if (!existing) throw new NotFoundError(`unknown feed post: ${id}`);
    this.mdb.db.prepare('UPDATE mm_feed_posts SET dismissed = 1 WHERE id = ?').run(id);
    return { ...existing, dismissed: true };
  }
}

/**
 * Post generator interface. Production implementations call an LLM with the
 * brief as context; the mock below is deterministic and makes zero network
 * calls (standing rule: zero paid usage in testing).
 */
export interface FeedGenerator {
  generate(brief: string): Promise<FeedPostDraft[]> | FeedPostDraft[];
}

/** Deterministic offline generator: one post per brief line/topic. */
export class MockFeedGenerator implements FeedGenerator {
  generate(brief: string): FeedPostDraft[] {
    const topics = brief
      .split(/[\n.]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    const list = topics.length > 0 ? topics : [brief.trim()];
    return list.map((topic, i) => ({
      title: `Brief item ${i + 1}: ${topic.length > 60 ? topic.slice(0, 57) + '…' : topic}`,
      body:
        `From your feed brief:\n\n> ${topic}\n\n` +
        '(Mock-generated post — connect a real generator for production content.)',
      sourceNote: 'mock-generator',
    }));
  }
}

/**
 * Generate posts from the stored brief and persist them. Throws when no
 * brief has been set yet.
 */
export async function generateFeedPosts(
  store: FeedStore,
  generator: FeedGenerator,
): Promise<FeedPost[]> {
  const brief = store.getBrief();
  if (!brief) throw new ValidationError('set a feed brief before generating posts');
  const drafts = await generator.generate(brief.brief);
  return drafts.map((d) => store.addPost(d));
}

/** Suggested daily cron for background feed generation (07:00 local). */
export function feedGenerationCron(): string {
  return '0 7 * * *';
}

/**
 * Scheduling hook: register a cron trigger in the existing workflows
 * TriggerStore so the host Scheduler fires background generation. The host
 * maps `workflowId` to a runner that calls generateFeedPosts().
 */
export function scheduleFeedGeneration(triggerStore: TriggerStore, workflowId: string): Trigger {
  return triggerStore.create({
    workflowId,
    kind: 'cron',
    cron: feedGenerationCron(),
    enabled: true,
  });
}

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { TriggerStore } from '@mvp/workflows';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import {
  FeedStore,
  MockFeedGenerator,
  generateFeedPosts,
  feedGenerationCron,
  scheduleFeedGeneration,
} from './index.js';

describe('FeedStore', () => {
  let db: ModuleDb;
  let store: FeedStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new FeedStore(db);
  });

  it('returns null brief before one is set', () => {
    expect(store.getBrief()).toBeNull();
  });

  it('sets and reads the brief', () => {
    const b = store.setBrief('AI news, markets, long reads');
    expect(b.brief).toBe('AI news, markets, long reads');
    expect(store.getBrief()?.brief).toBe(b.brief);
  });

  it('rejects empty / oversized briefs', () => {
    expect(() => store.setBrief('   ')).toThrow(ValidationError);
    expect(() => store.setBrief('x'.repeat(5001))).toThrow(ValidationError);
  });

  it('generates posts from the brief with the mock generator', async () => {
    store.setBrief('AI agents\nSaaS pricing');
    const posts = await generateFeedPosts(store, new MockFeedGenerator());
    expect(posts).toHaveLength(2);
    expect(posts[0].title).toContain('AI agents');
    expect(posts[0].dismissed).toBe(false);
    expect(store.listPosts()).toHaveLength(2);
  });

  it('refuses to generate without a brief', async () => {
    await expect(generateFeedPosts(store, new MockFeedGenerator())).rejects.toThrow(ValidationError);
  });

  it('dismiss hides posts from the default listing', async () => {
    store.setBrief('one topic');
    const [post] = await generateFeedPosts(store, new MockFeedGenerator());
    store.dismissPost(post.id);
    expect(store.listPosts()).toHaveLength(0);
    expect(store.listPosts(true)).toHaveLength(1);
  });

  it('dismiss of unknown post throws NotFoundError', () => {
    expect(() => store.dismissPost('nope')).toThrow(NotFoundError);
  });

  it('schedules a cron trigger via the workflows TriggerStore', () => {
    const triggers = new TriggerStore(':memory:');
    const trigger = scheduleFeedGeneration(triggers, 'muse-feed-dispatch');
    expect(trigger.kind).toBe('cron');
    expect(trigger.cron).toBe(feedGenerationCron());
    expect(trigger.workflowId).toBe('muse-feed-dispatch');
    triggers.close();
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import {
  MockSocialSearch,
  WatchlistStore,
  buildDigest,
  renderDigestMarkdown,
} from './index.js';

describe('WatchlistStore', () => {
  let db: ModuleDb;
  let store: WatchlistStore;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    store = new WatchlistStore(db);
  });

  it('adds keywords idempotently', () => {
    const a = store.add('ai agents');
    expect(store.add('ai agents').id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
  });

  it('validates keywords', () => {
    expect(() => store.add('  ')).toThrow(ValidationError);
  });

  it('removes entries', () => {
    const w = store.add('mvp launch');
    store.remove(w.id);
    expect(store.list()).toHaveLength(0);
    expect(() => store.remove(w.id)).toThrow(NotFoundError);
  });
});

describe('social listening', () => {
  it('MockSocialSearch returns deterministic fixture posts', () => {
    const search = new MockSocialSearch();
    const a = search.searchPosts('ai agents');
    const b = search.searchPosts('ai agents');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].keyword).toBe('ai agents');
    expect(() => search.searchPosts('')).toThrow(ValidationError);
  });

  it('buildDigest + renderDigestMarkdown cover the whole watchlist', async () => {
    const db = new ModuleDb(':memory:');
    const watchlist = new WatchlistStore(db);
    watchlist.add('ai agents');
    watchlist.add('mvp launch');
    const digest = await buildDigest(watchlist.list(), new MockSocialSearch());
    expect(digest).toHaveLength(2);
    expect(digest[0].posts.length).toBeGreaterThan(0);
    const md = renderDigestMarkdown(digest);
    expect(md).toContain('# Social listening digest');
    expect(md).toContain('"ai agents"');
    expect(md).toContain('untrusted');
  });
});

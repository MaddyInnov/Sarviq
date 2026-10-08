// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HISTORY_LIMIT,
  SessionStore,
} from '../src/sessions.js';

const ENV_KEY = 'SESSION_HISTORY_LIMIT';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  vi.restoreAllMocks();
});

function seed(store: SessionStore, sessionId: string, n: number): void {
  for (let i = 1; i <= n; i++) {
    store.appendMessage(sessionId, { role: 'user', content: `msg-${i}` });
  }
}

describe('getMessages rolling cap', () => {
  it('returns at most the default limit, oldest first dropped, in order', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seed(store, sid, DEFAULT_HISTORY_LIMIT + 50);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = store.getMessages(sid);

    expect(msgs).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect(msgs[0]?.content).toBe(`msg-51`);
    expect(msgs[msgs.length - 1]?.content).toBe(`msg-${DEFAULT_HISTORY_LIMIT + 50}`);
    // Order preserved across the kept window.
    for (let i = 0; i < msgs.length; i++) {
      expect(msgs[i]?.content).toBe(`msg-${51 + i}`);
    }
    // Warning names how many were dropped.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('dropped 50');
    store.close();
  });

  it('does not truncate or warn when history fits the limit', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seed(store, sid, 10);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = store.getMessages(sid);

    expect(msgs).toHaveLength(10);
    expect(warn).not.toHaveBeenCalled();
    store.close();
  });

  it('historyLimit is configurable via constructor', () => {
    const store = new SessionStore(':memory:', { historyLimit: 10 });
    const sid = store.createSession('bot-1');
    seed(store, sid, 25);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = store.getMessages(sid);

    expect(msgs).toHaveLength(10);
    expect(msgs[0]?.content).toBe('msg-16');
    expect(msgs[9]?.content).toBe('msg-25');
    store.close();
  });

  it('SESSION_HISTORY_LIMIT env var configures the cap', () => {
    process.env[ENV_KEY] = '25';
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seed(store, sid, 40);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msgs = store.getMessages(sid);

    expect(msgs).toHaveLength(25);
    expect(msgs[0]?.content).toBe('msg-16');
    store.close();
  });

  it('constructor option beats the env var', () => {
    process.env[ENV_KEY] = '25';
    const store = new SessionStore(':memory:', { historyLimit: 5 });
    const sid = store.createSession('bot-1');
    seed(store, sid, 40);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.getMessages(sid)).toHaveLength(5);
    store.close();
  });

  it('invalid limits fall back to the default', () => {
    process.env[ENV_KEY] = 'not-a-number';
    const store = new SessionStore(':memory:', { historyLimit: -3 });
    const sid = store.createSession('bot-1');
    seed(store, sid, DEFAULT_HISTORY_LIMIT + 1);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.getMessages(sid)).toHaveLength(DEFAULT_HISTORY_LIMIT);
    store.close();
  });
});

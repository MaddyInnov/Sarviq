// SPDX-License-Identifier: Apache-2.0
// Tests for SessionStore branch support (chat thread branching):
// - branchSession copies history up to and including the target message
// - unknown thread / unknown message return ok:false (404 mapping)
// - client-generated session ids (messages, no session row) are backfilled
// - listThreadMessages returns verbatim rows with stable ids

import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';
import type { ChatMessage } from '../src/types.js';

function seedTurn(store: SessionStore, sid: string): void {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'tell me more' },
    { role: 'assistant', content: 'all the details' },
  ];
  for (const m of msgs) store.appendMessage(sid, m);
}

describe('SessionStore.branchSession', () => {
  it('copies history up to and including the target message into a new session', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seedTurn(store, sid);
    const rows = store.listThreadMessages(sid);
    expect(rows).toHaveLength(4);
    expect(rows[0].id).toBeLessThan(rows[3].id);

    const target = rows[1]; // the first assistant reply
    const res = store.branchSession(sid, target.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.session.id).not.toBe(sid);
    expect(res.session.botId).toBe('bot-1');
    expect(res.copiedMessages).toBe(2);

    const branched = store.listThreadMessages(res.session.id);
    expect(branched.map((m) => m.content)).toEqual(['hello', 'hi there']);
    expect(branched.map((m) => m.role)).toEqual(['user', 'assistant']);
    // original untouched
    expect(store.listThreadMessages(sid)).toHaveLength(4);
  });

  it('branching from the last message copies the whole history', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seedTurn(store, sid);
    const rows = store.listThreadMessages(sid);
    const res = store.branchSession(sid, rows[rows.length - 1].id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.copiedMessages).toBe(4);
    expect(store.listThreadMessages(res.session.id)).toHaveLength(4);
  });

  it('returns thread-not-found for an unknown session', () => {
    const store = new SessionStore(':memory:');
    const res = store.branchSession('nope', 1);
    expect(res).toEqual({ ok: false, reason: 'thread-not-found' });
  });

  it('returns message-not-found for a message outside the thread', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seedTurn(store, sid);
    const other = store.createSession('bot-1');
    store.appendMessage(other, { role: 'user', content: 'elsewhere' });
    const foreignId = store.listThreadMessages(other)[0].id;
    const res = store.branchSession(sid, foreignId);
    expect(res).toEqual({ ok: false, reason: 'message-not-found' });
    const res2 = store.branchSession(sid, 999999);
    expect(res2).toEqual({ ok: false, reason: 'message-not-found' });
  });

  it('backfills a session row for client-generated ids (messages, no session row)', () => {
    const store = new SessionStore(':memory:');
    const clientId = 'convo_local_123';
    store.appendMessage(clientId, { role: 'user', content: 'hi' });
    store.appendMessage(clientId, { role: 'assistant', content: 'yo' });
    expect(store.getSession(clientId)).toBeUndefined();

    const rows = store.listThreadMessages(clientId);
    const res = store.branchSession(clientId, rows[0].id, 'bot-9');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.copiedMessages).toBe(1);
    // backfilled row makes the thread addressable afterwards
    expect(store.getSession(clientId)?.botId).toBe('bot-9');
    expect(res.session.botId).toBe('bot-9');
  });

  it('preserves tool call fields on copied messages', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    store.appendMessage(sid, { role: 'user', content: 'run it' });
    store.appendMessage(sid, {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'run_command', args: { cmd: 'ls' } }],
    } as ChatMessage);
    const rows = store.listThreadMessages(sid);
    expect(rows[1].toolCalls).toHaveLength(1);
    const res = store.branchSession(sid, rows[1].id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const branched = store.listThreadMessages(res.session.id);
    expect(branched[1].toolCalls).toEqual([{ id: 'call-1', name: 'run_command', args: { cmd: 'ls' } }]);
  });
});

describe('SessionStore.listThreadMessages', () => {
  it('returns verbatim rows in insertion order with stable ids', () => {
    const store = new SessionStore(':memory:');
    const sid = store.createSession('bot-1');
    seedTurn(store, sid);
    const rows = store.listThreadMessages(sid);
    expect(rows.map((m) => m.id)).toEqual([...rows.map((m) => m.id)].sort((a, b) => a - b));
    expect(rows.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(rows.every((m) => typeof m.ts === 'string')).toBe(true);
  });

  it('returns an empty array for unknown sessions', () => {
    const store = new SessionStore(':memory:');
    expect(store.listThreadMessages('nope')).toEqual([]);
  });
});

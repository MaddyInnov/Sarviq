// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PageCommentStore,
  PageMentionStore,
  PageStore,
  registerPagesRoutes,
} from '../src/pages.js';

describe('PageStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pages-'));
  });

  it('creates, lists, gets, updates, and deletes pages', () => {
    const store = new PageStore(dir);
    expect(store.list()).toEqual([]);

    const page = store.create({ title: '  Roadmap  ', content: '# hi', createdBy: 'ashutosh' });
    expect(page.title).toBe('Roadmap');
    expect(page.version).toBe(1);
    expect(page.createdBy).toBe('ashutosh');

    // Persistence across instances (same dataDir → same pages.db).
    const reopened = new PageStore(dir);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get(page.id)?.title).toBe('Roadmap');

    const updated = reopened.update(page.id, { content: '# hi\n\nmore' });
    expect(updated.version).toBe(2);
    expect(updated.content).toContain('more');

    reopened.remove(page.id);
    expect(reopened.get(page.id)).toBeUndefined();
    expect(reopened.list()).toEqual([]);
  });

  it('rejects invalid input', () => {
    const store = new PageStore(dir);
    expect(() => store.create({ title: '   ' })).toThrow(/title/);
    expect(() => store.create({ title: 'x'.repeat(201) })).toThrow(/title/);
    expect(() => store.update('missing', { title: 't' })).toThrow(/unknown page/);
    expect(() => store.remove('missing')).toThrow(/unknown page/);
  });

  it('snapshots versions on update and restores them', () => {
    const store = new PageStore(dir);
    const page = store.create({ title: 'Doc', content: 'v1' });
    store.update(page.id, { content: 'v2' });
    store.update(page.id, { content: 'v3', title: 'Doc!' });

    const versions = store.listVersions(page.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2); // most recent first
    expect(versions[0].content).toBe('v2');
    expect(versions[1].version).toBe(1);
    expect(versions[1].content).toBe('v1');

    const restored = store.restore(page.id, versions[1].id);
    expect(restored.content).toBe('v1');
    expect(restored.title).toBe('Doc');
    expect(restored.version).toBe(4);

    // Restoring snapshots the pre-restore state too.
    const after = store.listVersions(page.id);
    expect(after).toHaveLength(3);
    expect(after[0].content).toBe('v3');

    expect(() => store.restore(page.id, 'nope')).toThrow(/unknown page version/);
    expect(() => store.listVersions('missing')).toThrow(/unknown page/);
  });

  it('does not snapshot when nothing changed', () => {
    const store = new PageStore(dir);
    const page = store.create({ title: 'Doc', content: 'same' });
    const same = store.update(page.id, { content: 'same' });
    expect(same.version).toBe(1);
    expect(store.listVersions(page.id)).toHaveLength(0);
  });
});

describe('PageCommentStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'page-comments-'));
  });

  it('adds, lists, resolves, and removes comments', () => {
    const pages = new PageStore(dir);
    const comments = new PageCommentStore(dir);
    const page = pages.create({ title: 'Doc' });

    expect(comments.list(page.id)).toEqual([]);
    const c = comments.add(page.id, { author: 'ashutosh', text: 'check this' });
    expect(c.resolved).toBe(false);

    const resolved = comments.setResolved(page.id, c.id, true);
    expect(resolved.resolved).toBe(true);
    expect(comments.list(page.id)[0].resolved).toBe(true);

    comments.remove(page.id, c.id);
    expect(comments.list(page.id)).toEqual([]);

    expect(() => comments.add(page.id, { author: 'x', text: '   ' })).toThrow(/text/);
    expect(() => comments.setResolved(page.id, 'nope', true)).toThrow(/unknown comment/);
  });
});

describe('PageMentionStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'page-mentions-'));
  });

  it('records mentions and tracks status', () => {
    const pages = new PageStore(dir);
    const mentions = new PageMentionStore(dir);
    const page = pages.create({ title: 'Doc' });

    const m = mentions.add(page.id, { mentioned: 'coder', isBot: true, context: 'review this', author: 'ashutosh' });
    expect(m.status).toBe('pending');
    expect(m.isBot).toBe(true);

    mentions.setStatus(page.id, m.id, 'done');
    expect(mentions.list(page.id)[0].status).toBe('done');

    expect(() => mentions.add(page.id, { mentioned: '  ', isBot: false })).toThrow(/mentioned/);
  });
});

describe('pages router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  const bot = { id: 'coder', name: 'Coder', description: 'd', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pages-routes-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    // Fake agent runtime: emits two tokens then done.
    const agentRuntime = {
      runTurn: vi.fn(async ({ onEvent }: { onEvent: (e: { type: string; content?: string }) => Promise<void> }) => {
        await onEvent({ type: 'token', content: 'looks good' });
        await onEvent({ type: 'token', content: '!' });
        await onEvent({ type: 'done' });
        return { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
      }),
    };
    registerPagesRoutes(router, {
      dataDir: dir,
      agentRuntime: agentRuntime as unknown as import('@mvp/agent-runtime').AgentRuntime,
      getBots: () => [bot as unknown as import('@mvp/agent-runtime').BotConfig],
    });
    app.use('/api/pages', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/pages`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path = '', body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  it('CRUDs a page end to end with versions', async () => {
    expect((await api('GET')).json).toEqual([]);

    const created = await api('POST', '', { title: 'Plan', content: '# v1' });
    expect(created.status).toBe(201);
    const page = created.json as { id: string; version: number };
    expect(page.version).toBe(1);

    const fetched = await api('GET', `/${page.id}`);
    expect(fetched.status).toBe(200);
    expect((fetched.json as { comments: unknown[] }).comments).toEqual([]);

    const updated = await api('PUT', `/${page.id}`, { content: '# v2' });
    expect((updated.json as { version: number }).version).toBe(2);

    const versions = (await api('GET', `/${page.id}/versions`)).json as Array<{ id: string; content: string }>;
    expect(versions).toHaveLength(1);
    expect(versions[0].content).toBe('# v1');

    const restored = await api('POST', `/${page.id}/restore/${versions[0].id}`);
    expect((restored.json as { content: string }).content).toBe('# v1');
    expect((restored.json as { version: number }).version).toBe(3);

    expect(await api('DELETE', `/${page.id}`)).toMatchObject({ status: 200 });
    expect(await api('GET', `/${page.id}`)).toMatchObject({ status: 404 });
  });

  it('validates page input', async () => {
    expect((await api('POST', '', { title: '' })).status).toBe(400);
    expect((await api('GET', '/nope')).status).toBe(404);
    expect((await api('PUT', '/nope', { title: 't' })).status).toBe(404);
  });

  it('manages comments', async () => {
    const page = (await api('POST', '', { title: 'Doc' })).json as { id: string };

    const added = await api('POST', `/${page.id}/comments`, { author: 'ashutosh', text: 'nice' });
    expect(added.status).toBe(201);
    const comment = added.json as { id: string; resolved: boolean };

    expect(((await api('GET', `/${page.id}/comments`)).json as unknown[])).toHaveLength(1);

    const patched = await api('PATCH', `/${page.id}/comments/${comment.id}`, { resolved: true });
    expect((patched.json as { resolved: boolean }).resolved).toBe(true);

    expect((await api('DELETE', `/${page.id}/comments/${comment.id}`)).status).toBe(200);
    expect(((await api('GET', `/${page.id}/comments`)).json as unknown[])).toHaveLength(0);

    expect((await api('POST', `/${page.id}/comments`, { author: 'x', text: '' })).status).toBe(400);
    expect((await api('PATCH', `/${page.id}/comments/nope`, { resolved: true })).status).toBe(400);
  });

  it('triggers an agent turn on bot @mention and appends the reply', async () => {
    const page = (await api('POST', '', { title: 'Spec', content: 'draft' })).json as { id: string };

    const mentioned = await api('POST', `/${page.id}/mentions`, {
      mentioned: '@coder',
      context: 'review the draft',
      author: 'ashutosh',
    });
    expect(mentioned.status).toBe(201);
    expect((mentioned.json as { isBot: boolean }).isBot).toBe(true);
    expect((mentioned.json as { status: string }).status).toBe('pending');

    // Fire-and-forget turn completes asynchronously; poll for the appended reply.
    let content = '';
    for (let i = 0; i < 50 && !content.includes('looks good!'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      const p = (await api('GET', `/${page.id}`)).json as { content: string };
      content = p.content;
    }
    expect(content).toContain('**Coder** (via @mention)');
    expect(content).toContain('looks good!');

    const ms = (await api('GET', `/${page.id}/mentions`)).json as Array<{ status: string }>;
    expect(ms[0].status).toBe('done');
  });

  it('records human @mentions without triggering a turn', async () => {
    const page = (await api('POST', '', { title: 'Doc' })).json as { id: string };
    const mentioned = await api('POST', `/${page.id}/mentions`, { mentioned: 'teammate', author: 'ashutosh' });
    expect(mentioned.status).toBe(201);
    expect((mentioned.json as { isBot: boolean }).isBot).toBe(false);
  });

  it('streams page events over SSE', async () => {
    const page = (await api('POST', '', { title: 'Live' })).json as { id: string };

    const res = await fetch(`${baseUrl}/${page.id}/stream`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readEvent = async (): Promise<string> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error('stream closed');
        buf += decoder.decode(value, { stream: true });
        const idx = buf.indexOf('\n\n');
        if (idx >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.startsWith(':')) continue; // heartbeat/comment
          return chunk;
        }
      }
    };

    // Trigger an update; the SSE stream should deliver it.
    await api('PUT', `/${page.id}`, { content: 'hello live' });
    const event = await readEvent();
    expect(event).toContain('"kind":"page"');
    expect(event).toContain('hello live');

    await reader.cancel();
  });
});

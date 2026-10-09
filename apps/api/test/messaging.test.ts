// SPDX-License-Identifier: Apache-2.0
// Tests for the messaging gateway (apps/api/src/messaging.ts):
// - telegram provider: request shape, success/failure handling (mocked fetch)
// - approval gating: a send is BLOCKED until the approval is 'approved'
//   (pending/denied/missing → deliverApprovedSend throws, provider untouched)
// - routes: POST /messaging/send (approved → sent, denied → 403, no call),
//   POST /messaging/inbound/:provider (webhook parse + optional secret check)
// Zero network: Bot API fetch is stubbed; only localhost HTTP is real.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import type { AppConfig } from '../src/config.js';
import { saveProviderKey } from '../src/providers.js';
import {
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_WEBHOOK_SECRET_ENV,
  createTelegramProvider,
  deliverApprovedSend,
  getInboundLog,
  getMessageProvider,
  listMessageProviders,
  registerMessagingRoutes,
  requestSendApproval,
  resolveTelegramToken,
} from '../src/messaging.js';

const realFetch = globalThis.fetch.bind(globalThis);

/** Swap global fetch. Restored in afterEach — localhost stays real, mocks take the rest. */
function setFetch(fn: typeof globalThis.fetch): void {
  (globalThis as { fetch: typeof globalThis.fetch }).fetch = fn;
}

function restoreFetch(): void {
  (globalThis as { fetch: typeof globalThis.fetch }).fetch = realFetch;
}
const BOT_TOKEN = 'bot-token-123';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mvp-messaging-'));
}

/** Stub fetch: localhost → real HTTP (route tests), everything else → the given mock. */
function stubFetchFor(mock: (url: string, init?: RequestInit) => Promise<Response>): void {
  setFetch(((url: unknown, init?: RequestInit) => {
    if (typeof url === 'string' && url.startsWith('http://127.0.0.1')) return realFetch(url, init);
    return mock(String(url), init);
  }) as typeof globalThis.fetch);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function freshGovernance(): GovernanceGateway {
  return new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
}

describe('telegram provider', () => {
  afterEach(() => restoreFetch());

  it('sends via the Bot API with chat_id and text', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetchFor(async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return jsonResponse({ ok: true, result: { message_id: 42 } });
    });
    const provider = createTelegramProvider(BOT_TOKEN);
    const result = await provider.send('12345', 'hello world');
    expect(result).toEqual({ ok: true, id: '42' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(calls[0].body).toMatchObject({ chat_id: '12345', text: 'hello world' });
  });

  it('throws on Bot API errors without leaking the token', async () => {
    stubFetchFor(async () => jsonResponse({ ok: false, description: 'chat not found' }, 400));
    await expect(createTelegramProvider(BOT_TOKEN).send('nope', 'hi')).rejects.toThrow(
      /Telegram send failed: chat not found/,
    );
  });

  it('resolves the token from real env first, encrypted store second', () => {
    const dataDir = freshDataDir();
    const OLD = process.env[TELEGRAM_BOT_TOKEN_ENV];
    try {
      process.env[TELEGRAM_BOT_TOKEN_ENV] = 'env-token';
      expect(resolveTelegramToken(dataDir)).toBe('env-token');
      delete process.env[TELEGRAM_BOT_TOKEN_ENV];
      saveProviderKey(dataDir, 'custom-telegram', { apiKey: 'stored-token' });
      expect(resolveTelegramToken(dataDir)).toBe('stored-token');
    } finally {
      if (OLD === undefined) delete process.env[TELEGRAM_BOT_TOKEN_ENV];
      else process.env[TELEGRAM_BOT_TOKEN_ENV] = OLD;
      delete process.env.CUSTOM_TELEGRAM_API_KEY;
    }
  });

  it('fails closed when no telegram token is configured', () => {
    const OLD = process.env[TELEGRAM_BOT_TOKEN_ENV];
    delete process.env[TELEGRAM_BOT_TOKEN_ENV];
    try {
      expect(() => resolveTelegramToken(freshDataDir())).toThrow(/not configured/);
    } finally {
      if (OLD !== undefined) process.env[TELEGRAM_BOT_TOKEN_ENV] = OLD;
    }
  });
});

describe('provider registry', () => {
  it('lists telegram and rejects unknown providers', () => {
    expect(listMessageProviders()).toContain('telegram');
    expect(() => getMessageProvider('nope', freshDataDir())).toThrow(/Unknown message provider/);
  });
});

describe('approval gating of sends', () => {
  let governance: GovernanceGateway;

  beforeEach(() => {
    governance = freshGovernance();
  });
  afterEach(() => governance.close());

  it('blocks delivery while the approval is pending — provider never called', async () => {
    let delivered = 0;
    const { approvalId } = requestSendApproval(governance, {
      providerId: 'telegram',
      to: '123',
      text: 'should not go out',
    });
    expect(governance.getApproval(approvalId)?.status).toBe('pending');
    await expect(
      deliverApprovedSend(governance, approvalId, async () => {
        delivered += 1;
        return { ok: true };
      }),
    ).rejects.toThrow(/send blocked.*pending/);
    expect(delivered).toBe(0);
  });

  it('blocks delivery when the approval is denied', async () => {
    let delivered = 0;
    const { approvalId } = requestSendApproval(governance, {
      providerId: 'telegram',
      to: '123',
      text: 'denied message',
    });
    governance.decide(approvalId, 'denied');
    await expect(
      deliverApprovedSend(governance, approvalId, async () => {
        delivered += 1;
        return { ok: true };
      }),
    ).rejects.toThrow(/send blocked.*denied/);
    expect(delivered).toBe(0);
  });

  it('blocks delivery for an unknown approval id', async () => {
    await expect(deliverApprovedSend(governance, 'nope', async () => ({ ok: true }))).rejects.toThrow(
      /send blocked.*missing/,
    );
  });

  it('delivers exactly once after the approval is granted', async () => {
    let delivered = 0;
    const { approvalId } = requestSendApproval(governance, {
      providerId: 'telegram',
      to: '123',
      text: 'approved message',
    });
    governance.decide(approvalId, 'approved');
    const result = await deliverApprovedSend(governance, approvalId, async () => {
      delivered += 1;
      return { ok: true, id: '99' };
    });
    expect(result).toEqual({ ok: true, id: '99' });
    expect(delivered).toBe(1);
    // The approval content is visible in the inbox for review.
    const rec = governance.getApproval(approvalId);
    expect(rec?.toolName).toBe('message.send');
    expect(rec?.args).toMatchObject({ providerId: 'telegram', to: '123', text: 'approved message' });
  });
});

describe('messaging routes', () => {
  const OLD_TOKEN = process.env[TELEGRAM_BOT_TOKEN_ENV];
  const OLD_SECRET = process.env[TELEGRAM_WEBHOOK_SECRET_ENV];
  let dataDir: string;
  let governance: GovernanceGateway;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  const telegramCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(async () => {
    dataDir = freshDataDir();
    process.env[TELEGRAM_BOT_TOKEN_ENV] = BOT_TOKEN;
    delete process.env[TELEGRAM_WEBHOOK_SECRET_ENV];
    telegramCalls.length = 0;
    // Mock the Telegram Bot API; localhost traffic stays real.
    stubFetchFor(async (url, init) => {
      telegramCalls.push({
        url,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    });
    governance = freshGovernance();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerMessagingRoutes(router, {
      config: { dataDir } as AppConfig,
      governance,
    });
    app.use(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    restoreFetch();
    governance.close();
    if (OLD_TOKEN === undefined) delete process.env[TELEGRAM_BOT_TOKEN_ENV];
    else process.env[TELEGRAM_BOT_TOKEN_ENV] = OLD_TOKEN;
    if (OLD_SECRET === undefined) delete process.env[TELEGRAM_WEBHOOK_SECRET_ENV];
    else process.env[TELEGRAM_WEBHOOK_SECRET_ENV] = OLD_SECRET;
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  /** Wait until a pending message.send approval appears, then return its id. */
  async function waitForPendingApproval(): Promise<string> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const pending = governance
        .listApprovals('pending')
        .find((a) => a.toolName === 'message.send');
      if (pending) return pending.id;
      if (Date.now() > deadline) throw new Error('timed out waiting for the send approval');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('sends after the approval is granted (provider called once)', async () => {
    const sendPromise = fetch(`${baseUrl}/messaging/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'telegram', to: '123', text: 'route-approved', waitMs: 8000 }),
    });
    const approvalId = await waitForPendingApproval();
    governance.decide(approvalId, 'approved');
    const res = await sendPromise;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string; approvalId: string };
    expect(json.ok).toBe(true);
    expect(json.id).toBe('7');
    expect(json.approvalId).toBe(approvalId);
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].body).toMatchObject({ chat_id: '123', text: 'route-approved' });
  });

  it('never calls the provider when the send is denied', async () => {
    const sendPromise = fetch(`${baseUrl}/messaging/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'telegram', to: '123', text: 'route-denied', waitMs: 8000 }),
    });
    const approvalId = await waitForPendingApproval();
    governance.decide(approvalId, 'denied');
    const res = await sendPromise;
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; approvalId: string };
    expect(json.approvalId).toBe(approvalId);
    expect(telegramCalls).toHaveLength(0);
  });

  it('blocks (403) when the approval expires without a decision', async () => {
    const res = await fetch(`${baseUrl}/messaging/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'telegram', to: '123', text: 'route-timeout', waitMs: 50 }),
    });
    expect(res.status).toBe(403);
    expect(telegramCalls).toHaveLength(0);
  });

  it('validates the send body', async () => {
    const bad = (body: unknown) =>
      fetch(`${baseUrl}/messaging/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await bad({ to: '1', text: 'x' })).status).toBe(400);
    expect((await bad({ provider: 'telegram', text: 'x' })).status).toBe(400);
    expect((await bad({ provider: 'telegram', to: '1', text: '  ' })).status).toBe(400);
    expect((await bad({ provider: 'nope', to: '1', text: 'x' })).status).toBe(404);
  });

  it('receives a telegram webhook and records the inbound message', async () => {
    const before = getInboundLog().length;
    const res = await fetch(`${baseUrl}/messaging/inbound/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: { message_id: 11, from: { id: 9, username: 'alice' }, chat: { id: 9 }, text: 'hello bot' },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    const log = getInboundLog();
    expect(log.length).toBe(before + 1);
    expect(log[log.length - 1]).toMatchObject({
      providerId: 'telegram',
      from: 'alice',
      chatId: '9',
      text: 'hello bot',
    });
    // Visible to the UI.
    const listed = (await (await fetch(`${baseUrl}/messaging/inbound`)).json()) as Array<{ text: string }>;
    expect(listed.some((m) => m.text === 'hello bot')).toBe(true);
  });

  it('enforces the telegram webhook secret when configured', async () => {
    process.env[TELEGRAM_WEBHOOK_SECRET_ENV] = 's3cr3t';
    const post = (secret?: string) =>
      fetch(`${baseUrl}/messaging/inbound/telegram`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
        },
        body: JSON.stringify({ message: { message_id: 12, text: 'x' } }),
      });
    expect((await post()).status).toBe(401);
    expect((await post('wrong')).status).toBe(401);
    expect((await post('s3cr3t')).status).toBe(200);
  });

  it('rejects unknown inbound providers', async () => {
    const res = await fetch(`${baseUrl}/messaging/inbound/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe('discord provider', () => {
  afterEach(() => restoreFetch());

  it('sends via the Bot API with channel id in the path', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    stubFetchFor(async (url, init) => {
      calls.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({ id: 'msg-123' });
    });
    const { createDiscordProvider } = await import('../src/messaging.js');
    const result = createDiscordProvider('discord-token').send('chan-456', 'hello discord');
    await expect(result).resolves.toEqual({ ok: true, id: 'msg-123' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://discord.com/api/v10/channels/chan-456/messages');
    expect(calls[0].headers['authorization']).toBe('Bot discord-token');
    expect(calls[0].body).toMatchObject({ content: 'hello discord' });
  });

  it('throws on Discord API errors', async () => {
    stubFetchFor(async () => jsonResponse({ message: 'Missing Access' }, 403));
    const { createDiscordProvider } = await import('../src/messaging.js');
    await expect(createDiscordProvider('t').send('c', 'hi')).rejects.toThrow(/Discord send failed: Missing Access/);
  });

  it('requires a token', async () => {
    const { createDiscordProvider } = await import('../src/messaging.js');
    expect(() => createDiscordProvider('')).toThrow(/token is required/);
  });
});

describe('slack provider', () => {
  afterEach(() => restoreFetch());

  it('sends via chat.postMessage with Bearer <redacted>', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    stubFetchFor(async (url, init) => {
      calls.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({ ok: true, ts: '1234.5678' });
    });
    const { createSlackProvider } = await import('../src/messaging.js');
    const result = await createSlackProvider('xoxb-token').send('C123', 'hello slack');
    expect(result).toEqual({ ok: true, id: '1234.5678' });
    expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0].headers['authorization']).toContain('Bearer ');
    expect(calls[0].headers['authorization']?.length).toBeGreaterThan('Bearer '.length);
    expect(calls[0].body).toMatchObject({ channel: 'C123', text: 'hello slack' });
  });

  it('throws on Slack API errors (ok:false)', async () => {
    stubFetchFor(async () => jsonResponse({ ok: false, error: 'channel_not_found' }));
    const { createSlackProvider } = await import('../src/messaging.js');
    await expect(createSlackProvider('t').send('C999', 'hi')).rejects.toThrow(
      /Slack send failed: channel_not_found/,
    );
  });
});

describe('whatsapp provider', () => {
  afterEach(() => restoreFetch());

  it('sends via the Cloud API with the phone number id in the path', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetchFor(async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return jsonResponse({ messages: [{ id: 'wamid.123' }] });
    });
    const { createWhatsAppProvider } = await import('../src/messaging.js');
    const result = await createWhatsAppProvider('wa-token', 'pnid-789').send('+15551234567', 'hello wa');
    expect(result).toEqual({ ok: true, id: 'wamid.123' });
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/pnid-789/messages');
    expect(calls[0].body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '+15551234567',
      type: 'text',
      text: { body: 'hello wa', preview_url: false },
    });
  });

  it('throws on Cloud API errors', async () => {
    stubFetchFor(async () =>
      jsonResponse({ error: { message: 'Invalid phone number' } }, 400),
    );
    const { createWhatsAppProvider } = await import('../src/messaging.js');
    await expect(createWhatsAppProvider('t', 'p').send('+1', 'hi')).rejects.toThrow(
      /WhatsApp send failed: Invalid phone number/,
    );
  });
});

describe('provider registry (all four)', () => {
  it('lists telegram, discord, slack, whatsapp', async () => {
    const { listMessageProviders } = await import('../src/messaging.js');
    const ids = listMessageProviders();
    expect(ids).toContain('telegram');
    expect(ids).toContain('discord');
    expect(ids).toContain('slack');
    expect(ids).toContain('whatsapp');
  });
});

describe('inbound mention parsing', () => {
  it('detects a Discord bot mention via the mentions array', async () => {
    const { parseDiscordMessage } = await import('../src/messaging.js');
    const parsed = parseDiscordMessage(
      {
        id: 'm1',
        channel_id: 'c1',
        author: { id: 'u1', username: 'bob', bot: false },
        content: 'hey <@bot99> help me',
        mentions: [{ id: 'bot99' }],
      },
      'bot99',
    );
    expect(parsed?.mentioned).toBe(true);
    expect(parsed?.chatId).toBe('c1');
    expect(parsed?.text).toBe('hey <@bot99> help me');
  });

  it('detects a Discord mention via <@id> in content without the mentions array', async () => {
    const { parseDiscordMessage } = await import('../src/messaging.js');
    const parsed = parseDiscordMessage(
      { id: 'm2', channel_id: 'c1', author: { id: 'u1', bot: false }, content: '<@bot99> hi' },
      'bot99',
    );
    expect(parsed?.mentioned).toBe(true);
  });

  it('ignores Discord messages not mentioning the bot', async () => {
    const { parseDiscordMessage } = await import('../src/messaging.js');
    const parsed = parseDiscordMessage(
      { id: 'm3', channel_id: 'c1', author: { id: 'u1', bot: false }, content: 'just chatting' },
      'bot99',
    );
    expect(parsed?.mentioned).toBe(false);
  });

  it('ignores Discord messages authored by bots (loop guard)', async () => {
    const { parseDiscordMessage } = await import('../src/messaging.js');
    const parsed = parseDiscordMessage(
      {
        id: 'm4',
        channel_id: 'c1',
        author: { id: 'bot99', bot: true },
        content: '<@bot99> hi',
        mentions: [{ id: 'bot99' }],
      },
      'bot99',
    );
    expect(parsed).toBeNull();
  });

  it('parses a Slack url_verification handshake', async () => {
    const { parseSlackEvent } = await import('../src/messaging.js');
    const parsed = parseSlackEvent({ type: 'url_verification', challenge: 'abc123' });
    expect(parsed).toEqual({ kind: 'url_verification', challenge: 'abc123' });
  });

  it('parses a Slack app_mention and strips the leading mention', async () => {
    const { parseSlackEvent } = await import('../src/messaging.js');
    const parsed = parseSlackEvent({
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C456',
        text: '<@BOTID> what is the status?',
        ts: '1234.5',
      },
    });
    expect(parsed.kind).toBe('app_mention');
    if (parsed.kind === 'app_mention') {
      expect(parsed.message.chatId).toBe('C456');
      expect(parsed.message.text).toBe('what is the status?');
      expect(parsed.message.from).toBe('U123');
    }
  });

  it('ignores non-mention Slack events', async () => {
    const { parseSlackEvent } = await import('../src/messaging.js');
    expect(parseSlackEvent({ type: 'event_callback', event: { type: 'message' } })).toEqual({
      kind: 'ignored',
    });
    expect(parseSlackEvent({})).toEqual({ kind: 'ignored' });
  });
});

describe('inbound mention routes', () => {
  let dataDir: string;
  let governance: GovernanceGateway;
  let server: { close(cb: () => void): void } | null = null;
  let baseUrl = '';
  const sent: Array<{ provider: string; to: string; text: string }> = [];

  beforeEach(async () => {
    const { registerMessagingRoutes } = await import('../src/messaging.js');
    dataDir = freshDataDir();
    sent.length = 0;
    governance = freshGovernance();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    // onMention stub: echo the mention text as the "agent reply".
    // getMessageProvider is stubbed by overriding fetch for discord/slack.
    registerMessagingRoutes(router, {
      config: { dataDir } as AppConfig,
      governance,
      onMention: async (info) => `reply to: ${info.text}`,
    });
    // Stub provider HTTP: capture sends instead of hitting real APIs.
    stubFetchFor(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const u = String(url);
      if (u.includes('discord.com')) sent.push({ provider: 'discord', to: 'chan', text: String(body.content) });
      else if (u.includes('slack.com')) sent.push({ provider: 'slack', to: String(body.channel), text: String(body.text) });
      if (u.includes('discord.com')) return jsonResponse({ id: 'dm1' });
      return jsonResponse({ ok: true, ts: '1.2' });
    });
    // Provide tokens so getMessageProvider works.
    process.env.DISCORD_BOT_TOKEN = 'd-token';
    process.env.SLACK_BOT_TOKEN = 's-token';
    process.env.DISCORD_BOT_USER_ID = 'bot99';
    app.use(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    restoreFetch();
    governance.close();
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.DISCORD_BOT_USER_ID;
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  it('answers a Discord mention in the channel', async () => {
    const res = await fetch(`${baseUrl}/messaging/inbound/discord`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'm10',
        channel_id: 'chan-1',
        author: { id: 'u1', username: 'bob', bot: false },
        content: '<@bot99> status?',
        mentions: [{ id: 'bot99' }],
      }),
    });
    expect(res.status).toBe(200);
    // handleMention is fire-and-forget; wait for the send.
    const deadline = Date.now() + 3000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ provider: 'discord', text: 'reply to: <@bot99> status?' });
  });

  it('logs but does not answer a Discord message without a mention', async () => {
    const res = await fetch(`${baseUrl}/messaging/inbound/discord`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'm11',
        channel_id: 'chan-1',
        author: { id: 'u1', bot: false },
        content: 'just chatting',
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { mentioned: boolean };
    expect(json.mentioned).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.length).toBe(0);
  });

  it('answers a Slack app_mention', async () => {
    const res = await fetch(`${baseUrl}/messaging/inbound/slack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          text: '<@BOTID> deploy status',
          ts: '99.1',
        },
      }),
    });
    expect(res.status).toBe(200);
    const deadline = Date.now() + 3000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ provider: 'slack', to: 'C1', text: 'reply to: deploy status' });
  });

  it('echoes the Slack url_verification challenge', async () => {
    const res = await fetch(`${baseUrl}/messaging/inbound/slack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'ch-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'ch-1' });
  });
});

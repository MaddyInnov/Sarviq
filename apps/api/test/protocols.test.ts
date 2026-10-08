// SPDX-License-Identifier: Apache-2.0

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2AServer, AGUIEmitter, defaultAgentCard, textMessage } from '@mvp/protocols';
import { registerProtocolRoutes } from '../src/protocols.js';

describe('protocol routes', () => {
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let emitter: AGUIEmitter;
  let a2a: A2AServer;

  beforeEach(async () => {
    emitter = new AGUIEmitter();
    a2a = new A2AServer({
      card: defaultAgentCard('http://test/api/protocols/a2a'),
      handler: async (message) => ({ echo: message.parts.map((p) => p.text).join(' ') }),
    });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerProtocolRoutes(router, {
      agentCardUrl: 'http://test/api/protocols/a2a',
      a2aServer: a2a,
      aguiEmitter: emitter,
    });
    app.use('/api/protocols', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/protocols`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  it('serves the agent card', async () => {
    const res = await fetch(`${baseUrl}/agent-card`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as { name: string; url: string; skills: unknown[] };
    expect(card.name).toBeTruthy();
    expect(card.url).toBe('http://test/api/protocols/a2a');
    expect(card.skills.length).toBeGreaterThan(0);
  });

  it('handles A2A message/send over JSON-RPC', async () => {
    const res = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'n1',
        method: 'message/send',
        params: { message: textMessage('hello agent') },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: string;
      result: { status: { state: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe('n1');
    expect(body.result.status.state).toBe('completed');
  });

  it('returns JSON-RPC method-not-found for unknown methods', async () => {
    const res = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'n2', method: 'bogus/method' }),
    });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it('streams AG-UI events over SSE', async () => {
    const res = await fetch(`${baseUrl}/agui/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Emit after subscribing; the handler is synchronous fan-out.
    setTimeout(() => emitter.text('stream says hi'), 50);

    const deadline = Date.now() + 5000;
    let sawEvent = false;
    while (Date.now() < deadline && !sawEvent) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('"type":"text_message_content"') && buffer.includes('stream says hi')) {
        sawEvent = true;
      }
    }
    await reader.cancel();
    expect(sawEvent).toBe(true);
  });
});

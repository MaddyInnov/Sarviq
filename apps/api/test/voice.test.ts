// SPDX-License-Identifier: Apache-2.0

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockSTTProvider, MockTTSProvider } from '@mvp/voice';
import { registerVoiceRoutes } from '../src/voice.js';

describe('voice routes', () => {
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerVoiceRoutes(router, { stt: new MockSTTProvider(), tts: new MockTTSProvider() });
    app.use('/api/voice', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/voice`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('reports the selected providers', async () => {
    const { status, json } = await api('GET', '/providers');
    expect(status).toBe(200);
    expect(json).toEqual({ stt: 'mock', tts: 'mock' });
  });

  it('transcribes audio via POST /stt', async () => {
    const audioBase64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    const { status, json } = await api('POST', '/stt', { audioBase64, language: 'en' });
    expect(status).toBe(200);
    const body = json as { text: string; provider: string; language: string };
    expect(body.provider).toBe('mock');
    expect(body.language).toBe('en');
    expect(body.text).toContain('mock microphone');
  });

  it('rejects /stt without audio', async () => {
    const { status, json } = await api('POST', '/stt', {});
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/audioBase64/);
  });

  it('synthesizes speech via POST /tts', async () => {
    const { status, json } = await api('POST', '/tts', { text: 'hello there' });
    expect(status).toBe(200);
    const body = json as { audioBase64: string; mimeType: string; provider: string };
    expect(body.provider).toBe('mock');
    expect(body.mimeType).toBe('audio/wav');
    const bytes = Buffer.from(body.audioBase64, 'base64');
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('rejects /tts without text', async () => {
    const { status } = await api('POST', '/tts', { text: '   ' });
    expect(status).toBe(400);
  });
});

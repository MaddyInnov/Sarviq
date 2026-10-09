// SPDX-License-Identifier: Apache-2.0
//
// Groq voice provider tests. The HTTP layer is fully mocked — no test may
// ever reach api.groq.com (standing rule: zero paid API usage in tests).

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GROQ_STT_MODEL,
  DEFAULT_GROQ_TTS_MODEL,
  DEFAULT_GROQ_TTS_VOICE,
  GROQ_VOICE_BASE_URL,
  GroqSTTProvider,
  GroqTTSProvider,
} from '../src/groq.js';
import { selectSTTProvider, selectTTSProvider } from '../src/voice.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): Captured {
  const captured: Captured = { url: '' };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init;
    return handler(String(url), init);
  }) as typeof fetch;
  return captured;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bytesResponse(bytes: Uint8Array, mime = 'audio/wav'): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'Content-Type': mime },
  });
}

const KEY_ENV = { GROQ_API_KEY: 'gsk_test_key_never_sent' };

describe('GroqSTTProvider', () => {
  it('POSTs multipart audio to /audio/transcriptions and returns the text', async () => {
    const captured = stubFetch((url, init) => {
      expect(url).toBe(`${GROQ_VOICE_BASE_URL}/audio/transcriptions`);
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer gsk_test_key_never_sent');
      const form = init?.body as FormData;
      expect(form.get('model')).toBe(DEFAULT_GROQ_STT_MODEL);
      expect(form.get('response_format')).toBe('json');
      expect(form.get('file')).toBeInstanceOf(Blob);
      return jsonResponse({ text: 'hello from the whisper mock' });
    });
    const stt = new GroqSTTProvider({ env: KEY_ENV });
    const res = await stt.transcribe(new Uint8Array([1, 2, 3, 4]));
    expect(res.text).toBe('hello from the whisper mock');
    expect(captured.url).toContain('api.groq.com');
  });

  it('throws a clear error when GROQ_API_KEY is missing', () => {
    expect(() => new GroqSTTProvider({ env: {} })).toThrow(/GROQ_API_KEY/);
  });

  it('rejects empty audio before any network call', async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return jsonResponse({ text: 'x' });
    });
    await expect(new GroqSTTProvider({ env: KEY_ENV }).transcribe(new Uint8Array(0))).rejects.toThrow(
      /non-empty/,
    );
    expect(calls).toBe(0);
  });

  it('surfaces provider errors with status and body excerpt', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'bad key' } }, 401));
    await expect(
      new GroqSTTProvider({ env: KEY_ENV }).transcribe(new Uint8Array([1])),
    ).rejects.toThrow(/401/);
  });

  it('supports an explicit model override', async () => {
    const captured = stubFetch((_url, init) => {
      expect((init?.body as FormData).get('model')).toBe('whisper-large-v3');
      return jsonResponse({ text: 'ok' });
    });
    const res = await new GroqSTTProvider({
      env: KEY_ENV,
      sttModel: 'whisper-large-v3',
    }).transcribe(new Uint8Array([1]));
    expect(res.text).toBe('ok');
    expect(captured.url).toBe(`${GROQ_VOICE_BASE_URL}/audio/transcriptions`);
  });
});

describe('GroqTTSProvider', () => {
  it('POSTs JSON to /audio/speech and returns audio bytes with the right mime', async () => {
    const captured = stubFetch((url, init) => {
      expect(url).toBe(`${GROQ_VOICE_BASE_URL}/audio/speech`);
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer gsk_test_key_never_sent');
      expect(headers.get('Content-Type')).toContain('application/json');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(DEFAULT_GROQ_TTS_MODEL);
      expect(body.input).toBe('hello world');
      expect(body.voice).toBe(DEFAULT_GROQ_TTS_VOICE);
      expect(body.response_format).toBe('wav');
      return bytesResponse(new Uint8Array([82, 73, 70, 70])); // "RIFF"
    });
    const tts = new GroqTTSProvider({ env: KEY_ENV });
    const res = await tts.synthesize('hello world');
    expect(res.mimeType).toBe('audio/wav');
    expect([...res.audio.slice(0, 4)]).toEqual([82, 73, 70, 70]);
    expect(captured.url).toContain('api.groq.com');
  });

  it('honours format mp3 and per-call voice', async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.response_format).toBe('mp3');
      expect(body.voice).toBe('Celeste-PlayAI');
      return bytesResponse(new Uint8Array([1, 2, 3]), 'audio/mpeg');
    });
    const res = await new GroqTTSProvider({ env: KEY_ENV }).synthesize('hi', {
      format: 'mp3',
      voice: 'Celeste-PlayAI',
    });
    expect(res.mimeType).toBe('audio/mpeg');
    expect(res.audio.length).toBe(3);
  });

  it('throws a clear error when GROQ_API_KEY is missing', () => {
    expect(() => new GroqTTSProvider({ env: {} })).toThrow(/GROQ_API_KEY/);
  });

  it('validates input before any network call', async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return bytesResponse(new Uint8Array([1]));
    });
    await expect(new GroqTTSProvider({ env: KEY_ENV }).synthesize('   ')).rejects.toThrow(
      /non-empty/,
    );
    expect(calls).toBe(0);
  });

  it('surfaces provider errors with status', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'quota' } }, 429));
    await expect(new GroqTTSProvider({ env: KEY_ENV }).synthesize('hi')).rejects.toThrow(/429/);
  });
});

describe('voice selectors (groq branch)', () => {
  it('selectSTTProvider returns a Groq STT provider for VOICE_STT_PROVIDER=groq', () => {
    const stt = selectSTTProvider({ VOICE_STT_PROVIDER: 'groq', ...KEY_ENV });
    expect(stt).toBeInstanceOf(GroqSTTProvider);
    expect(stt.name).toBe('groq');
  });

  it('selectTTSProvider returns a Groq TTS provider for VOICE_TTS_PROVIDER=groq', () => {
    const tts = selectTTSProvider({ VOICE_TTS_PROVIDER: 'groq', ...KEY_ENV });
    expect(tts).toBeInstanceOf(GroqTTSProvider);
    expect(tts.name).toBe('groq');
  });

  it('mock stays the default when no env is set', () => {
    expect(selectSTTProvider({}).name).toBe('mock');
    expect(selectTTSProvider({}).name).toBe('mock');
  });
});

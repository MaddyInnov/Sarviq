// SPDX-License-Identifier: Apache-2.0
// Voice HTTP routes (@mvp/voice over express).
//
// Mount at boot, e.g.:
//   import { registerVoiceRoutes } from './voice.js';
//   const voiceRouter = express.Router();
//   registerVoiceRoutes(voiceRouter); // providers selected via VOICE_STT_PROVIDER / VOICE_TTS_PROVIDER (default: mock)
//   app.use('/api/voice', voiceRouter);
//
// Routes (router mounted at /api/voice):
//   GET  /providers → { stt, tts } (selected provider names)
//   POST /stt        → { audioBase64, mimeType?, language? } → { text, confidence?, language, provider }
//   POST /tts        → { text, voice?, format? } → { audioBase64, mimeType, durationMs?, provider }
//
// Mock-first (standing rule: zero paid usage in tests): the default 'mock'
// providers cost nothing and touch no network. Real provider ids throw until
// wired — and real providers must read keys from env, never hardcoded.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  selectSTTProvider,
  selectTTSProvider,
  type STTProvider,
  type TTSProvider,
} from '@mvp/voice';

export interface VoiceRouteDeps {
  stt?: STTProvider;
  tts?: TTSProvider;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function decodeAudioBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('"audioBase64" must be a non-empty base64 string');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) throw new Error('"audioBase64" did not decode to any bytes');
  if (bytes.length > 10 * 1024 * 1024) throw new Error('audio too large (max 10MB)');
  return new Uint8Array(bytes);
}

export function registerVoiceRoutes(router: Router, deps: VoiceRouteDeps = {}): void {
  const stt = deps.stt ?? selectSTTProvider();
  const tts = deps.tts ?? selectTTSProvider();

  router.get('/providers', (_req: Request, res: Response) => {
    res.json({ stt: stt.name, tts: tts.name });
  });

  router.post('/stt', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { audioBase64?: unknown; mimeType?: unknown; language?: unknown };
      const audio = decodeAudioBase64(body.audioBase64);
      const result = await stt.transcribe(audio, {
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
        language: typeof body.language === 'string' ? body.language : undefined,
      });
      res.json({ ...result, provider: stt.name });
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'STT failed') });
    }
  });

  router.post('/tts', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        text?: unknown;
        voice?: unknown;
        format?: unknown;
      };
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        res.status(400).json({ error: '"text" must be a non-empty string' });
        return;
      }
      const result = await tts.synthesize(body.text, {
        voice: typeof body.voice === 'string' ? body.voice : undefined,
        format: body.format === 'mp3' ? 'mp3' : 'wav',
      });
      res.json({
        audioBase64: Buffer.from(result.audio).toString('base64'),
        mimeType: result.mimeType,
        durationMs: result.durationMs,
        provider: tts.name,
      });
    } catch (err) {
      res.status(400).json({ error: errMessage(err, 'TTS failed') });
    }
  });
}

// SPDX-License-Identifier: Apache-2.0
// Groq voice providers: STT (Whisper) and TTS (PlayAI) over Groq's
// OpenAI-compatible audio endpoints:
//
//   STT: POST https://api.groq.com/openai/v1/audio/transcriptions
//        (multipart: file, model, language?, response_format=json)
//   TTS: POST https://api.groq.com/openai/v1/audio/speech
//        (JSON: model, input, voice, response_format)
//
// Key-gated by design: the key is read from GROQ_API_KEY (or passed
// explicitly) and never logged. The mock providers in voice.ts remain the
// default — these only activate when VOICE_STT_PROVIDER/VOICE_TTS_PROVIDER
// is set to 'groq'.

import type {
  STTProvider,
  STTResult,
  STTTranscribeOptions,
  TTSProvider,
  TTSResult,
  TTSSynthesizeOptions,
} from './voice.js';

/** Groq's OpenAI-compatible base (matches the LLM catalog preset). */
export const GROQ_VOICE_BASE_URL = 'https://api.groq.com/openai/v1';

/** Env var holding the Groq API key (same var the LLM provider path uses). */
export const GROQ_API_KEY_ENV_VAR = 'GROQ_API_KEY';

/** Whisper STT models served by Groq. Turbo = best speed/accuracy balance. */
export const GROQ_STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'] as const;
export const DEFAULT_GROQ_STT_MODEL = 'whisper-large-v3-turbo';

/** TTS models served by Groq. */
export const GROQ_TTS_MODELS = ['playai-tts', 'playai-tts-arabic'] as const;
export const DEFAULT_GROQ_TTS_MODEL = 'playai-tts';
export const DEFAULT_GROQ_TTS_VOICE = 'Fritz-PlayAI';

export interface GroqVoiceOptions {
  /** API key; falls back to GROQ_API_KEY in env. Never logged or persisted. */
  apiKey?: string;
  /** Override for tests/proxies; defaults to GROQ_VOICE_BASE_URL. */
  baseUrl?: string;
  /** STT model id; default 'whisper-large-v3-turbo'. */
  sttModel?: string;
  /** TTS model id; default 'playai-tts'. */
  ttsModel?: string;
  /** Default PlayAI voice; overridable per call via TTSSynthesizeOptions.voice. */
  ttsVoice?: string;
  /** Env source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

function resolveVoiceConfig(opts: GroqVoiceOptions): Required<Omit<GroqVoiceOptions, 'env'>> {
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env[GROQ_API_KEY_ENV_VAR];
  if (!apiKey) {
    throw new Error(
      `groq voice: missing ${GROQ_API_KEY_ENV_VAR}. Set the ${GROQ_API_KEY_ENV_VAR} environment ` +
        `variable (or pass apiKey explicitly), or leave VOICE_*_PROVIDER unset to use the mock.`,
    );
  }
  return {
    apiKey,
    baseUrl: (opts.baseUrl ?? GROQ_VOICE_BASE_URL).replace(/\/+$/, ''),
    sttModel: opts.sttModel ?? DEFAULT_GROQ_STT_MODEL,
    ttsModel: opts.ttsModel ?? DEFAULT_GROQ_TTS_MODEL,
    ttsVoice: opts.ttsVoice ?? DEFAULT_GROQ_TTS_VOICE,
  };
}

async function groqRequest(
  url: string,
  init: RequestInit,
  apiKey: string,
  label: string,
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `${label} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`,
    );
  }
  return res;
}

/**
 * Groq STT via the OpenAI-compatible /audio/transcriptions endpoint.
 * Key-gated; zero calls happen without GROQ_API_KEY.
 */
export class GroqSTTProvider implements STTProvider {
  readonly name = 'groq' as const;
  private readonly cfg: Required<Omit<GroqVoiceOptions, 'env'>>;

  constructor(opts: GroqVoiceOptions = {}) {
    this.cfg = resolveVoiceConfig(opts);
  }

  async transcribe(audio: Uint8Array, opts: STTTranscribeOptions = {}): Promise<STTResult> {
    if (!(audio instanceof Uint8Array) || audio.length === 0) {
      throw new Error('groq STT: audio must be a non-empty Uint8Array');
    }
    const form = new FormData();
    // Copy into a fresh ArrayBuffer view so the multipart part owns its bytes.
    const bytes = new Uint8Array(audio);
    form.append(
      'file',
      new Blob([bytes.buffer as ArrayBuffer], { type: opts.mimeType ?? 'audio/wav' }),
      'audio.wav',
    );
    form.append('model', this.cfg.sttModel);
    form.append('response_format', 'json');
    if (opts.language) form.append('language', opts.language);
    const res = await groqRequest(
      `${this.cfg.baseUrl}/audio/transcriptions`,
      { method: 'POST', body: form },
      this.cfg.apiKey,
      'groq STT',
    );
    const data = (await res.json()) as { text?: unknown };
    if (typeof data.text !== 'string' || !data.text) {
      throw new Error('groq STT: unexpected response shape (missing text)');
    }
    return { text: data.text, language: opts.language };
  }
}

/**
 * Groq TTS via the OpenAI-compatible /audio/speech endpoint (PlayAI).
 * Key-gated; zero calls happen without GROQ_API_KEY.
 */
export class GroqTTSProvider implements TTSProvider {
  readonly name = 'groq' as const;
  private readonly cfg: Required<Omit<GroqVoiceOptions, 'env'>>;

  constructor(opts: GroqVoiceOptions = {}) {
    this.cfg = resolveVoiceConfig(opts);
  }

  async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('groq TTS: text must be non-empty');
    const format = opts.format ?? 'wav';
    if (format !== 'wav' && format !== 'mp3') {
      throw new Error(`groq TTS: unsupported format "${format}" (supported: wav, mp3)`);
    }
    const res = await groqRequest(
      `${this.cfg.baseUrl}/audio/speech`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.ttsModel,
          input: trimmed,
          voice: opts.voice ?? this.cfg.ttsVoice,
          response_format: format,
        }),
      },
      this.cfg.apiKey,
      'groq TTS',
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('groq TTS: empty audio response');
    return {
      audio: buf,
      mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    };
  }
}

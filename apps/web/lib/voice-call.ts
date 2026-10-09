// SPDX-License-Identifier: Apache-2.0
// Live-call turn orchestration: mic audio → STT → bot reply → TTS.
//
// Pure orchestration over the @mvp/voice provider interfaces — no DOM, no
// MediaRecorder here, so it unit-tests cleanly with the real mock providers
// (MockSTTProvider / MockTTSProvider, zero cost). The CallPanel component in
// components/voice/ owns capture + playback and calls into this.

import type {
  STTProvider,
  STTTranscribeOptions,
  TTSProvider,
  TTSResult,
  TTSSynthesizeOptions,
} from '@mvp/voice';

export interface CallTurnInput {
  stt: STTProvider;
  tts: TTSProvider;
  /** Raw captured mic audio. */
  audio: Uint8Array;
  /** The bot "brain": maps a transcript to reply text. */
  respond: (transcript: string) => Promise<string> | string;
  language?: string;
  sttOpts?: STTTranscribeOptions;
  ttsOpts?: TTSSynthesizeOptions;
}

export interface CallTurn {
  id: string;
  at: number;
  transcript: string;
  replyText: string;
  replyAudio: TTSResult;
}

let turnSeq = 0;

/**
 * Run one full voice-call turn: transcribe the inbound audio, ask the brain
 * for a reply, synthesize the reply. Throws on empty audio or empty reply
 * (callers surface these as call errors, not turns).
 */
export async function runCallTurn(input: CallTurnInput): Promise<CallTurn> {
  const { stt, tts, audio, respond, language } = input;
  if (!(audio instanceof Uint8Array) || audio.length === 0) {
    throw new Error('call turn: audio must be a non-empty Uint8Array');
  }
  const { text: transcript } = await stt.transcribe(audio, {
    language,
    ...input.sttOpts,
  });
  const replyText = (await respond(transcript)).trim();
  if (!replyText) throw new Error('call turn: the bot returned an empty reply');
  const replyAudio = await tts.synthesize(replyText, { language, ...input.ttsOpts });
  return {
    id: `callturn_${Date.now().toString(36)}_${turnSeq++}`,
    at: Date.now(),
    transcript,
    replyText,
    replyAudio,
  };
}

/** Phases of a live call, for the panel UI state machine. */
export type CallPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

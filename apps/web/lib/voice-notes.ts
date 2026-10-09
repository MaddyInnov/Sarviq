// SPDX-License-Identifier: Apache-2.0
// Voice-note capture pipeline: MediaRecorder → Blob → data URL → STT.
//
// All browser globals are injected through `CaptureDeps` so the pipeline is
// unit-testable in Node with fakes (see lib/voice-notes.test.ts). UI code in
// components/voice/ wires the real browser implementations.

import type { STTProvider, STTTranscribeOptions } from '@mvp/voice';

/** Minimal structural MediaRecorder surface used by the pipeline. */
export interface MediaRecorderLike {
  readonly mimeType: string;
  readonly state: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface CaptureDeps {
  getUserMedia(constraints: { audio: boolean }): Promise<MediaStream>;
  createRecorder(stream: MediaStream): MediaRecorderLike;
}

export function browserCaptureDeps(): CaptureDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream) => new MediaRecorder(stream) as unknown as MediaRecorderLike,
  };
}

export interface CapturedAudio {
  blob: Blob;
  mimeType: string;
  /** Recording length in ms (measured with a wall clock around the session). */
  durationMs: number;
  dataUrl: string;
}

export interface VoiceNote {
  audioDataUrl: string;
  mimeType: string;
  durationMs: number;
  transcript: string;
}

/** Blob → `data:<mime>;base64,…` URL (local-first: no upload, no object-URL lifetime). */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

/**
 * Record one voice note. Resolves when `stop()` is called; rejects when the
 * microphone is unavailable. The caller owns the returned controller and
 * must call `stop()` exactly once.
 */
export async function startCapture(deps: CaptureDeps): Promise<{
  stop: () => Promise<CapturedAudio>;
}> {
  const stream = await deps.getUserMedia({ audio: true });
  const chunks: Blob[] = [];
  const recorder = deps.createRecorder(stream);
  const startedAt = Date.now();
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  };
  const stopped = new Promise<CapturedAudio>((resolve, reject) => {
    recorder.onstop = () => {
      try {
        for (const track of stream.getTracks()) track.stop();
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const durationMs = Date.now() - startedAt;
        blobToDataUrl(blob).then(
          (dataUrl) => resolve({ blob, mimeType: blob.type, durationMs, dataUrl }),
          reject,
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
  });
  recorder.start();
  return { stop: () => (recorder.stop(), stopped) };
}

/** Transcribe captured audio through an STTProvider (the @mvp/voice interface). */
export async function transcribeCapture(
  stt: STTProvider,
  captured: CapturedAudio,
  opts: STTTranscribeOptions = {},
): Promise<string> {
  const buffer = await captured.blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const result = await stt.transcribe(bytes, {
    mimeType: captured.mimeType,
    ...opts,
  });
  return result.text;
}

/**
 * Max voice-note payload persisted to localStorage (chars of data URL).
 * ~900k chars ≈ 675 KB of audio — keeps the mvp:blocks:* keys well under
 * quota. Notes over the cap still send and play in-session; only the
 * persisted copy drops its audio (transcript is always kept).
 */
export const VOICE_NOTE_PERSIST_LIMIT = 900_000;

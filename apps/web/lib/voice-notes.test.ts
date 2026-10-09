// SPDX-License-Identifier: Apache-2.0
// Pipeline tests with a fake MediaRecorder and the REAL MockSTTProvider
// from @mvp/voice (deterministic, zero cost, zero network).
import { describe, expect, it } from 'vitest';
import { MockSTTProvider } from '@mvp/voice';
import {
  blobToDataUrl,
  startCapture,
  transcribeCapture,
  type CaptureDeps,
  type MediaRecorderLike,
} from './voice-notes';

class FakeRecorder implements MediaRecorderLike {
  readonly mimeType = 'audio/webm';
  state = 'inactive';
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  startCount = 0;
  stopCount = 0;

  start(): void {
    this.state = 'recording';
    this.startCount++;
    // Emit one chunk, like a real recorder would.
    this.ondataavailable?.({ data: new Blob(['fake-audio-bytes']) });
  }

  stop(): void {
    this.state = 'inactive';
    this.stopCount++;
    this.onstop?.();
  }
}

function fakeDeps(): { deps: CaptureDeps; recorder: FakeRecorder; micStopped: { v: boolean } } {
  const recorder = new FakeRecorder();
  const micStopped = { v: false };
  const stream = {
    getTracks: () => [{ stop: () => void (micStopped.v = true) }],
  } as unknown as MediaStream;
  return {
    deps: {
      getUserMedia: async () => stream,
      createRecorder: () => recorder,
    },
    recorder,
    micStopped,
  };
}

describe('blobToDataUrl', () => {
  it('encodes a blob as a data URL that decodes back', async () => {
    const url = await blobToDataUrl(new Blob(['hello'], { type: 'audio/webm' }));
    expect(url.startsWith('data:audio/webm;base64,')).toBe(true);
    const b64 = url.split(',', 2)[1] ?? '';
    expect(Buffer.from(b64, 'base64').toString()).toBe('hello');
  });
});

describe('startCapture', () => {
  it('records until stop() and returns audio + a data URL', async () => {
    const { deps, recorder, micStopped } = fakeDeps();
    const { stop } = await startCapture(deps);
    expect(recorder.startCount).toBe(1);
    const captured = await stop();
    expect(recorder.stopCount).toBe(1);
    expect(captured.mimeType).toBe('audio/webm');
    expect(captured.blob.size).toBeGreaterThan(0);
    expect(captured.durationMs).toBeGreaterThanOrEqual(0);
    expect(captured.dataUrl.startsWith('data:audio/webm;base64,')).toBe(true);
    // Mic tracks are released on stop.
    expect(micStopped.v).toBe(true);
  });

  it('rejects when the microphone is unavailable', async () => {
    const deps: CaptureDeps = {
      getUserMedia: async () => {
        throw new Error('denied');
      },
      createRecorder: () => new FakeRecorder(),
    };
    await expect(startCapture(deps)).rejects.toThrow('denied');
  });
});

describe('transcribeCapture', () => {
  it('transcribes through the @mvp/voice STT interface (mock)', async () => {
    const { deps } = fakeDeps();
    const { stop } = await startCapture(deps);
    const captured = await stop();
    const text = await transcribeCapture(new MockSTTProvider('canned transcript'), captured, {
      language: 'en',
    });
    expect(text).toContain('canned transcript');
  });
});

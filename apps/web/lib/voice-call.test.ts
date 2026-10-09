// SPDX-License-Identifier: Apache-2.0
// Turn-orchestration tests with the REAL mock providers from @mvp/voice
// (deterministic, zero cost, zero network).
import { describe, expect, it } from 'vitest';
import { MockSTTProvider, MockTTSProvider } from '@mvp/voice';
import { runCallTurn } from './voice-call';

describe('runCallTurn', () => {
  it('runs mic → STT → respond → TTS and returns a complete turn', async () => {
    const turn = await runCallTurn({
      stt: new MockSTTProvider('mock heard'),
      tts: new MockTTSProvider(),
      audio: new Uint8Array([1, 2, 3, 4]),
      respond: async (transcript) => `mock reply to: ${transcript}`,
      language: 'en',
    });
    expect(turn.transcript).toContain('mock heard');
    expect(turn.replyText).toContain('mock reply to:');
    expect(turn.replyText).toContain('mock heard');
    expect(turn.replyAudio.audio.length).toBeGreaterThan(0);
    expect(turn.replyAudio.mimeType).toBe('audio/wav');
    expect(turn.id).toMatch(/^callturn_/);
  });

  it('accepts a sync respond function', async () => {
    const turn = await runCallTurn({
      stt: new MockSTTProvider(),
      tts: new MockTTSProvider(),
      audio: new Uint8Array([7]),
      respond: () => 'sync reply',
    });
    expect(turn.replyText).toBe('sync reply');
  });

  it('rejects empty audio', async () => {
    await expect(
      runCallTurn({
        stt: new MockSTTProvider(),
        tts: new MockTTSProvider(),
        audio: new Uint8Array([]),
        respond: async () => 'x',
      }),
    ).rejects.toThrow(/non-empty/);
  });

  it('rejects an empty bot reply', async () => {
    await expect(
      runCallTurn({
        stt: new MockSTTProvider(),
        tts: new MockTTSProvider(),
        audio: new Uint8Array([1]),
        respond: async () => '   ',
      }),
    ).rejects.toThrow(/empty reply/);
  });

  it('propagates STT failures', async () => {
    const broken = {
      name: 'broken',
      transcribe: async () => {
        throw new Error('mic exploded');
      },
    };
    await expect(
      runCallTurn({
        stt: broken,
        tts: new MockTTSProvider(),
        audio: new Uint8Array([1]),
        respond: async () => 'x',
      }),
    ).rejects.toThrow('mic exploded');
  });
});

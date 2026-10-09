// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import {
  MeetingStore,
  validateAudioFile,
  transcribeMeetingAudio,
  meetingSummaryPrompt,
  parseMeetingSummary,
  renderMeetingNotesMarkdown,
  MAX_AUDIO_BYTES,
  type MeetingSTTProvider,
} from './index.js';
import { ValidationError } from '../errors.js';

/** Deterministic mock STT for tests. */
class TestSTT implements MeetingSTTProvider {
  readonly name = 'test-mock';
  constructor(private readonly text: string) {}
  async transcribe(): Promise<{ text: string }> {
    return { text: this.text };
  }
}

describe('MeetingStore', () => {
  let mdb: ModuleDb;
  let store: MeetingStore;
  beforeEach(() => {
    mdb = new ModuleDb(':memory:');
    store = new MeetingStore(mdb);
  });

  it('records and lists meetings', () => {
    const m = store.record({ title: 'Standup', pageId: 'page-1', fileName: 'standup.mp3' });
    expect(m.id).toBeTruthy();
    expect(m.title).toBe('Standup');
    expect(store.list()).toHaveLength(1);
    expect(store.get(m.id).pageId).toBe('page-1');
  });

  it('rejects empty title', () => {
    expect(() => store.record({ title: '  ', pageId: 'p', fileName: 'a.mp3' })).toThrow(ValidationError);
  });
});

describe('validateAudioFile', () => {
  it('accepts mp3/wav/m4a', () => {
    expect(() => validateAudioFile('meeting.mp3', 1000)).not.toThrow();
    expect(() => validateAudioFile('meeting.WAV', 1000)).not.toThrow();
    expect(() => validateAudioFile('meeting.m4a', 1000)).not.toThrow();
  });

  it('rejects non-audio extensions', () => {
    expect(() => validateAudioFile('notes.txt', 1000)).toThrow(ValidationError);
    expect(() => validateAudioFile('video.mp4', 1000)).toThrow(ValidationError);
  });

  it('rejects empty and oversized files', () => {
    expect(() => validateAudioFile('a.mp3', 0)).toThrow(ValidationError);
    expect(() => validateAudioFile('a.mp3', MAX_AUDIO_BYTES + 1)).toThrow(ValidationError);
  });
});

describe('transcribeMeetingAudio', () => {
  it('transcribes via the STT provider', async () => {
    const { text } = await transcribeMeetingAudio(new TestSTT('hello team'), new Uint8Array([1, 2, 3]), 'm.mp3');
    expect(text).toBe('hello team');
  });

  it('rejects invalid files before calling STT', async () => {
    await expect(transcribeMeetingAudio(new TestSTT('x'), new Uint8Array([1]), 'm.txt')).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('parseMeetingSummary', () => {
  it('parses valid agent JSON', () => {
    const s = parseMeetingSummary(
      JSON.stringify({ summary: 'Good meeting.', actionItems: ['Ship it'], keyDecisions: ['Go live'] }),
    );
    expect(s.summary).toBe('Good meeting.');
    expect(s.actionItems).toEqual(['Ship it']);
    expect(s.keyDecisions).toEqual(['Go live']);
  });

  it('tolerates code fences', () => {
    const s = parseMeetingSummary('```json\n{"summary":"S","actionItems":[],"keyDecisions":[]}\n```');
    expect(s.summary).toBe('S');
  });

  it('rejects invalid JSON and empty summary', () => {
    expect(() => parseMeetingSummary('not json')).toThrow(ValidationError);
    expect(() => parseMeetingSummary('{"summary":"","actionItems":[],"keyDecisions":[]}')).toThrow(ValidationError);
  });
});

describe('renderMeetingNotesMarkdown', () => {
  it('renders summary, actions, decisions, and transcript', () => {
    const md = renderMeetingNotesMarkdown({
      title: 'Standup',
      date: '2026-10-09',
      transcript: 'hello team',
      summary: { summary: 'Quick sync.', actionItems: ['Fix bug'], keyDecisions: ['Ship Friday'] },
    });
    expect(md).toContain('# Standup');
    expect(md).toContain('Quick sync.');
    expect(md).toContain('- [ ] Fix bug');
    expect(md).toContain('- Ship Friday');
    expect(md).toContain('hello team');
    expect(md).toContain('Audio deleted after processing');
  });
});

describe('meetingSummaryPrompt', () => {
  it('includes the transcript and JSON instructions', () => {
    const p = meetingSummaryPrompt('discuss launch');
    expect(p).toContain('discuss launch');
    expect(p).toContain('actionItems');
    expect(p).toContain('keyDecisions');
  });
});

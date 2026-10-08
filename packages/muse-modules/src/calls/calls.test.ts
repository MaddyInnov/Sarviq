// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { MockVoiceCallProvider, CallLog } from './index.js';

describe('MockVoiceCallProvider', () => {
  const provider = new MockVoiceCallProvider();

  it('simulates an outbound call with no network', async () => {
    const rec = await provider.placeCall('+15551234567', { summary: 'test call', durationSec: 42 });
    expect(rec.direction).toBe('outbound');
    expect(rec.peer).toBe('+15551234567');
    expect(rec.durationSec).toBe(42);
    expect(rec.summary).toBe('test call');
    expect(rec.status).toBe('simulated');
    expect(rec.recordingRef).toMatch(/^mock:\/\/recordings\/.+\.wav$/);
  });

  it('validates input', async () => {
    await expect(provider.placeCall('')).rejects.toThrow(ValidationError);
    await expect(provider.placeCall('+1', { durationSec: -5 })).rejects.toThrow(ValidationError);
  });
});

describe('CallLog', () => {
  let db: ModuleDb;
  let log: CallLog;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    log = new CallLog(db);
  });

  it('logs and lists calls newest-first', () => {
    const provider = new MockVoiceCallProvider();
    return provider.placeCall('+15550000001').then((rec) => {
      log.log({ ...rec, startedAt: rec.startedAt - 1000 });
      const rec2 = log.log({
        direction: 'inbound',
        peer: '+15550000002',
        startedAt: Date.now(),
        durationSec: 10,
        summary: 'inbound',
        recordingRef: null,
        status: 'completed',
      });
      const list = log.list();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(rec2.id);
      expect(log.get(rec2.id).peer).toBe('+15550000002');
    });
  });

  it('get of unknown call throws NotFoundError', () => {
    expect(() => log.get('nope')).toThrow(NotFoundError);
  });
});

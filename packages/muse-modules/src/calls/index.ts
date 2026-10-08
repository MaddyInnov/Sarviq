// SPDX-License-Identifier: Apache-2.0
// Voice calls (Muse parity): call log + provider interface + mock provider.
//
// REAL TELEPHONY IS EXPLICITLY OUT OF SCOPE for this workstream. There is no
// SIP/PSTN integration here — MockVoiceCallProvider simulates a call and
// records it in the call log so the UI, approvals, and audit surfaces work
// end to end. Founder telephony inputs (Twilio/Telnyx credentials) are
// documented in docs/founder-setup.d/workstream-e.md; a real provider would
// implement VoiceCallProvider behind this same interface.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type CallDirection = 'inbound' | 'outbound';
export type CallStatus = 'completed' | 'simulated' | 'failed';

export interface CallRecord {
  id: string;
  direction: CallDirection;
  /** E.164-ish peer identifier supplied by the caller; stored as given. */
  peer: string;
  startedAt: number;
  durationSec: number;
  summary: string;
  /** e.g. mock://recordings/<id>.wav — null when no recording exists. */
  recordingRef: string | null;
  status: CallStatus;
}

export interface PlaceCallOptions {
  summary?: string;
  /** Simulated duration; ignored by real providers. */
  durationSec?: number;
}

export interface VoiceCallProvider {
  readonly name: string;
  placeCall(to: string, opts?: PlaceCallOptions): Promise<CallRecord>;
}

/**
 * Mock provider: simulates an outbound call instantly and returns a
 * clearly-labelled `simulated` record. Makes no network calls.
 */
export class MockVoiceCallProvider implements VoiceCallProvider {
  readonly name = 'mock';

  async placeCall(to: string, opts: PlaceCallOptions = {}): Promise<CallRecord> {
    const peer = (to ?? '').trim();
    if (!peer) throw new ValidationError('call "to" must be a non-empty peer identifier');
    if (peer.length > 64) throw new ValidationError('call "to" must be at most 64 characters');
    const durationSec = opts.durationSec ?? 60;
    if (!Number.isInteger(durationSec) || durationSec < 0 || durationSec > 7200) {
      throw new ValidationError('call "durationSec" must be an integer 0–7200');
    }
    const id = randomUUID();
    return {
      id,
      direction: 'outbound',
      peer,
      startedAt: Date.now(),
      durationSec,
      summary: (opts.summary ?? '').trim().slice(0, 2000),
      recordingRef: `mock://recordings/${id}.wav`,
      status: 'simulated',
    };
  }
}

interface CallRow {
  id: string;
  direction: string;
  peer: string;
  started_at: number;
  duration_sec: number;
  summary: string;
  recording_ref: string | null;
  status: string;
}

function rowToRecord(row: CallRow): CallRecord {
  return {
    id: row.id,
    direction: row.direction as CallDirection,
    peer: row.peer,
    startedAt: row.started_at,
    durationSec: row.duration_sec,
    summary: row.summary,
    recordingRef: row.recording_ref,
    status: row.status as CallStatus,
  };
}

/** Persistent call log, newest first. */
export class CallLog {
  constructor(private readonly mdb: ModuleDb) {}

  log(record: Omit<CallRecord, 'id'>): CallRecord {
    const full: CallRecord = { ...record, id: randomUUID() };
    this.mdb.db
      .prepare(
        `INSERT INTO mm_calls (id, direction, peer, started_at, duration_sec, summary, recording_ref, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.direction,
        full.peer,
        full.startedAt,
        full.durationSec,
        full.summary,
        full.recordingRef,
        full.status,
      );
    return full;
  }

  get(id: string): CallRecord {
    const row = this.mdb.db
      .prepare(
        'SELECT id, direction, peer, started_at, duration_sec, summary, recording_ref, status FROM mm_calls WHERE id = ?',
      )
      .get(id) as CallRow | undefined;
    if (!row) throw new NotFoundError(`unknown call: ${id}`);
    return rowToRecord(row);
  }

  list(limit = 50): CallRecord[] {
    const n = Math.min(Math.max(limit, 1), 500);
    const rows = this.mdb.db
      .prepare(
        `SELECT id, direction, peer, started_at, duration_sec, summary, recording_ref, status
         FROM mm_calls ORDER BY started_at DESC LIMIT ?`,
      )
      .all(n) as unknown as unknown as CallRow[];
    return rows.map(rowToRecord);
  }
}

// SPDX-License-Identifier: Apache-2.0
// Teach-by-recording API for the per-bot computer view (workstream A).
//
// Contract-first: the computer view (WS screenshots + user click/type input)
// does not exist yet. These routes define the exact producer contract it
// will emit to, and the compiler/persistence behind them are fully wired and
// fixture-tested today:
//
//   POST /api/computer/record/start        -> { ok, recording } (events: [])
//   POST /api/computer/record/:id/events   -> append coordinate input events
//   POST /api/computer/record/:id/stop      -> { ok, recording } (full event list)
//   POST /api/computer/record/:id/convert  -> compile + register a reusable
//                                            workflow; visible in the
//                                            Workflows destination via
//                                            GET /api/workflows
//
// Recorded event shape (all fields optional except type/timestamp):
//   { type: 'computer_click', x, y, timestamp }
//   { type: 'computer_type', text, timestamp }
//   { type: 'computer_key', key, timestamp }
//   { type: 'computer_screenshot', timestamp }
//   { type: 'computer_wait', ms, timestamp }
//
// Start/stop/convert are audit-logged (computer.record_started /
// computer.record_stopped / computer.record_converted).

import express from 'express';

import type { GovernanceGateway } from '@mvp/governance';
import {
  COMPUTER_RECORDED_EVENT_TYPES,
  compileComputerRecordingToWorkflow,
  type ComputerRecordedEvent,
  type WorkflowRunner,
} from '@mvp/workflows';

import type { RecordedEvent, RecordingStore } from './recordings.js';

export interface ComputerRecordRouteDeps {
  recordingStore: RecordingStore;
  workflowRunner: WorkflowRunner;
  governance: GovernanceGateway;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate a raw payload as a computer-view recorded event. Returns the
 * normalized RecordedEvent or an error string.
 */
function validateComputerEvent(raw: unknown): { event?: RecordedEvent; error?: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'event must be an object' };
  const e = raw as Record<string, unknown>;
  if (typeof e['type'] !== 'string') return { error: 'event must have a type' };
  const type = e['type'] as ComputerRecordedEvent['type'];
  if (!COMPUTER_RECORDED_EVENT_TYPES.has(type)) {
    return { error: `unknown computer event type "${e['type']}"` };
  }
  const event: RecordedEvent = { type, timestamp: isFiniteNumber(e['timestamp']) ? e['timestamp'] : Date.now() };

  if (type === 'computer_click') {
    if (!isFiniteNumber(e['x']) || !isFiniteNumber(e['y'])) {
      return { error: 'computer_click requires finite x and y' };
    }
    event.x = e['x'];
    event.y = e['y'];
  } else if (type === 'computer_type') {
    if (typeof e['text'] !== 'string' || e['text'].length === 0) {
      return { error: 'computer_type requires non-empty text' };
    }
    event.text = e['text'];
  } else if (type === 'computer_key') {
    if (typeof e['key'] !== 'string' || e['key'].length === 0) {
      return { error: 'computer_key requires a non-empty key name' };
    }
    event.key = e['key'];
  } else if (type === 'computer_wait') {
    if (e['ms'] !== undefined && !isFiniteNumber(e['ms'])) {
      return { error: 'computer_wait ms must be a number' };
    }
    event.ms = isFiniteNumber(e['ms']) ? Math.max(0, e['ms']) : 1000;
  }
  return { event };
}

function toCompilerEvent(e: RecordedEvent): ComputerRecordedEvent {
  return {
    type: e.type as ComputerRecordedEvent['type'],
    x: e.x,
    y: e.y,
    text: e.text,
    key: e.key,
    ms: e.ms,
    timestamp: e.timestamp,
  };
}

export function registerComputerRecordRoutes(router: express.Router, deps: ComputerRecordRouteDeps): void {
  const { recordingStore, workflowRunner, governance } = deps;

  router.post('/computer/record/start', (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; botId?: unknown };
    const rec = recordingStore.start(typeof body.name === 'string' ? body.name : '');
    const botId = typeof body.botId === 'string' ? body.botId : undefined;
    governance.audit('computer.record_started', {
      actor: 'api',
      toolName: 'computer_record',
      detail: { recordingId: rec.id, name: rec.name, botId: botId ?? null },
    });
    res.json({ ok: true, recording: rec });
  });

  router.post('/computer/record/:id/events', (req, res) => {
    const body = (req.body ?? {}) as { events?: unknown };
    if (!Array.isArray(body.events)) {
      res.status(400).json(errorBody('events must be an array'));
      return;
    }
    const validated: RecordedEvent[] = [];
    for (const raw of body.events) {
      const { event, error } = validateComputerEvent(raw);
      if (!event) {
        res.status(400).json(errorBody('invalid computer event', error));
        return;
      }
      validated.push(event);
    }
    const rec = recordingStore.addEvents(req.params.id, validated);
    if (!rec) {
      res.status(404).json(errorBody(`Unknown or stopped recording "${req.params.id}"`));
      return;
    }
    res.json({ ok: true, recording: rec });
  });

  router.post('/computer/record/:id/stop', (req, res) => {
    const rec = recordingStore.stop(req.params.id);
    if (!rec) {
      res.status(404).json(errorBody(`Unknown or stopped recording "${req.params.id}"`));
      return;
    }
    governance.audit('computer.record_stopped', {
      actor: 'api',
      toolName: 'computer_record',
      detail: { recordingId: rec.id, eventCount: rec.events.length },
    });
    res.json({ ok: true, recording: rec });
  });

  router.post('/computer/record/:id/convert', (req, res) => {
    const rec = recordingStore.get(req.params.id);
    if (!rec) {
      res.status(404).json(errorBody(`Unknown recording "${req.params.id}"`));
      return;
    }
    if (rec.status === 'recording') {
      res.status(400).json(errorBody('Stop the recording before converting'));
      return;
    }
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : rec.name;
    try {
      const def = compileComputerRecordingToWorkflow(rec.events.map(toCompilerEvent), { name });
      // register() validates the DAG (exactly one trigger, acyclic) and
      // persists it — the workflow then shows up in GET /api/workflows and
      // the Workflows destination.
      workflowRunner.register(def);
      recordingStore.markConverted(rec.id, def.id);
      governance.audit('computer.record_converted', {
        actor: 'api',
        toolName: 'computer_record',
        detail: { recordingId: rec.id, workflowId: def.id, eventCount: rec.events.length },
      });
      res.json({ ok: true, workflowId: def.id, workflow: def });
    } catch (err) {
      res.status(500).json(errorBody('Failed to compile recording', err instanceof Error ? err.message : String(err)));
    }
  });
}

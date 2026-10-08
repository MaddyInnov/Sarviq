// SPDX-License-Identifier: Apache-2.0
// AG-UI (agent-to-UI) event-stream protocol: the event schema a web client
// consumes plus a server-side emitter.
//
// Event taxonomy (mirrors the AG-UI run-agent-input/event shape closely
// enough for the web client to render):
//   - text_message_start/content/end   — assistant text deltas
//   - tool_call_start/args/end/result  — tool invocation lifecycle
//   - state_snapshot / state_delta     — agent state for the UI to mirror
//   - custom { name, value }           — widget payloads (charts, cards…)
//
// The emitter is framework-agnostic (no express): the API layer subscribes
// a listener per SSE connection and forwards serialized events.

import { randomUUID } from 'node:crypto';

/** One event on the AG-UI stream. Discriminated by `type`. */
export type AGUIEvent =
  | { type: 'text_message_start'; messageId: string }
  | { type: 'text_message_content'; messageId: string; delta: string }
  | { type: 'text_message_end'; messageId: string }
  | { type: 'tool_call_start'; toolCallId: string; toolCallName: string }
  | { type: 'tool_call_args'; toolCallId: string; delta: string }
  | { type: 'tool_call_end'; toolCallId: string }
  | { type: 'tool_call_result'; toolCallId: string; content: string }
  | { type: 'state_snapshot'; snapshot: Record<string, unknown> }
  | { type: 'state_delta'; delta: unknown[] }
  | { type: 'custom'; name: string; value: unknown };

export type AGUIEventType = AGUIEvent['type'];

export type AGUIListener = (event: AGUIEvent) => void;

/**
 * Server-side event emitter. Synchronous fan-out; listeners must not throw
 * (a throwing listener is isolated so one bad subscriber can't break the
 * stream for everyone else).
 */
export class AGUIEmitter {
  private readonly listeners = new Set<AGUIListener>();

  subscribe(listener: AGUIListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  emit(event: AGUIEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Isolate faulty subscribers; the stream must survive.
      }
    }
  }

  // --- convenience helpers so producers don't hand-build every envelope ---

  textStart(messageId: string = newMessageId()): string {
    this.emit({ type: 'text_message_start', messageId });
    return messageId;
  }

  textDelta(messageId: string, delta: string): void {
    this.emit({ type: 'text_message_content', messageId, delta });
  }

  textEnd(messageId: string): void {
    this.emit({ type: 'text_message_end', messageId });
  }

  /** Emit a complete assistant message as start/content/end. */
  text(message: string, messageId: string = newMessageId()): string {
    this.textStart(messageId);
    this.textDelta(messageId, message);
    this.textEnd(messageId);
    return messageId;
  }

  toolCallStart(toolCallId: string, toolCallName: string): void {
    this.emit({ type: 'tool_call_start', toolCallId, toolCallName });
  }

  toolCallArgs(toolCallId: string, argsJson: string): void {
    this.emit({ type: 'tool_call_args', toolCallId, delta: argsJson });
  }

  toolCallEnd(toolCallId: string): void {
    this.emit({ type: 'tool_call_end', toolCallId });
  }

  toolCallResult(toolCallId: string, content: string): void {
    this.emit({ type: 'tool_call_result', toolCallId, content });
  }

  stateSnapshot(snapshot: Record<string, unknown>): void {
    this.emit({ type: 'state_snapshot', snapshot });
  }

  stateDelta(delta: unknown[]): void {
    this.emit({ type: 'state_delta', delta });
  }

  /** Widget/custom payload for the client to render (charts, cards, …). */
  custom(name: string, value: unknown): void {
    this.emit({ type: 'custom', name, value });
  }
}

export function newMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Bridge a runtime StreamEvent (see @mvp/agent-runtime types) into the
 * AG-UI schema so the existing chat pipeline can feed this stream without
 * changes. Returns null for events with no AG-UI equivalent.
 */
export function bridgeRuntimeEvent(event: {
  type: string;
  content?: string;
  call?: { id: string; name: string };
  result?: unknown;
}): AGUIEvent | null {
  switch (event.type) {
    case 'token':
      return {
        type: 'text_message_content',
        messageId: 'assistant',
        delta: typeof event.content === 'string' ? event.content : '',
      };
    case 'tool_call':
      return event.call
        ? { type: 'tool_call_start', toolCallId: event.call.id, toolCallName: event.call.name }
        : null;
    case 'tool_result':
      return event.call
        ? {
            type: 'tool_call_result',
            toolCallId: event.call.id,
            content: safeStringify(event.result),
          }
        : null;
    case 'approval_required':
      return event.call
        ? {
            type: 'custom',
            name: 'approval_required',
            value: { toolCallId: event.call.id, toolName: event.call.name },
          }
        : null;
    case 'done':
      return { type: 'custom', name: 'run_done', value: {} };
    case 'error':
      return { type: 'custom', name: 'run_error', value: { message: event.content ?? 'unknown' } };
    default:
      return null;
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Serialize one AG-UI event as an SSE data frame. Never throws. */
export function serializeSseEvent(event: AGUIEvent): string {
  let payload: string;
  try {
    payload = JSON.stringify(event);
  } catch {
    payload = JSON.stringify({ type: 'custom', name: 'serialization_error', value: null });
  }
  return `data: ${payload}\n\n`;
}

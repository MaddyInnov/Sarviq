// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  AGUIEmitter,
  bridgeRuntimeEvent,
  serializeSseEvent,
  type AGUIEvent,
} from '../src/ag-ui.js';

function collect(emitter: AGUIEmitter): { events: AGUIEvent[]; stop: () => void } {
  const events: AGUIEvent[] = [];
  const stop = emitter.subscribe((e) => events.push(e));
  return { events, stop };
}

describe('AGUIEmitter', () => {
  it('fans out text message events in order', () => {
    const emitter = new AGUIEmitter();
    const { events } = collect(emitter);
    const id = emitter.textStart();
    emitter.textDelta(id, 'hello ');
    emitter.textDelta(id, 'world');
    emitter.textEnd(id);
    expect(events.map((e) => e.type)).toEqual([
      'text_message_start',
      'text_message_content',
      'text_message_content',
      'text_message_end',
    ]);
    expect(events[1]).toMatchObject({ messageId: id, delta: 'hello ' });
  });

  it('emits tool call lifecycle + result', () => {
    const emitter = new AGUIEmitter();
    const { events } = collect(emitter);
    emitter.toolCallStart('tc1', 'read_file');
    emitter.toolCallArgs('tc1', '{"path":"a.txt"}');
    emitter.toolCallEnd('tc1');
    emitter.toolCallResult('tc1', 'file contents');
    expect(events.map((e) => e.type)).toEqual([
      'tool_call_start',
      'tool_call_args',
      'tool_call_end',
      'tool_call_result',
    ]);
    expect(events[3]).toMatchObject({ toolCallId: 'tc1', content: 'file contents' });
  });

  it('emits state snapshots, deltas, and widget payloads', () => {
    const emitter = new AGUIEmitter();
    const { events } = collect(emitter);
    emitter.stateSnapshot({ step: 1 });
    emitter.stateDelta([{ op: 'replace', path: '/step', value: 2 }]);
    emitter.custom('chart', { kind: 'bar', data: [1, 2, 3] });
    expect(events[0]).toMatchObject({ type: 'state_snapshot', snapshot: { step: 1 } });
    expect(events[2]).toMatchObject({ type: 'custom', name: 'chart' });
  });

  it('unsubscribes cleanly', () => {
    const emitter = new AGUIEmitter();
    const { events, stop } = collect(emitter);
    expect(emitter.listenerCount()).toBe(1);
    stop();
    expect(emitter.listenerCount()).toBe(0);
    emitter.text('no one hears this');
    expect(events).toHaveLength(0);
  });

  it('isolates a throwing listener', () => {
    const emitter = new AGUIEmitter();
    emitter.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const { events } = collect(emitter);
    emitter.text('still delivered');
    expect(events.map((e) => e.type)).toEqual([
      'text_message_start',
      'text_message_content',
      'text_message_end',
    ]);
  });
});

describe('bridgeRuntimeEvent', () => {
  it('maps token → text_message_content', () => {
    expect(bridgeRuntimeEvent({ type: 'token', content: 'hi' })).toMatchObject({
      type: 'text_message_content',
      delta: 'hi',
    });
  });

  it('maps tool_call → tool_call_start', () => {
    expect(
      bridgeRuntimeEvent({ type: 'tool_call', call: { id: 'c1', name: 'read_file', args: {} } }),
    ).toMatchObject({ type: 'tool_call_start', toolCallId: 'c1', toolCallName: 'read_file' });
  });

  it('maps tool_result → tool_call_result', () => {
    expect(
      bridgeRuntimeEvent({
        type: 'tool_result',
        call: { id: 'c1', name: 'read_file', args: {} },
        result: 'ok',
      }),
    ).toMatchObject({ type: 'tool_call_result', toolCallId: 'c1', content: 'ok' });
  });

  it('maps approval_required and done/error to custom widget events', () => {
    expect(
      bridgeRuntimeEvent({
        type: 'approval_required',
        call: { id: 'c9', name: 'computer_click', args: {} },
      }),
    ).toMatchObject({ type: 'custom', name: 'approval_required' });
    expect(bridgeRuntimeEvent({ type: 'done' })).toMatchObject({
      type: 'custom',
      name: 'run_done',
    });
    expect(bridgeRuntimeEvent({ type: 'error', content: 'bad' })).toMatchObject({
      type: 'custom',
      name: 'run_error',
    });
  });

  it('returns null for unmapped events', () => {
    expect(bridgeRuntimeEvent({ type: 'something_new' })).toBeNull();
  });
});

describe('serializeSseEvent', () => {
  it('produces a valid SSE data frame', () => {
    const frame = serializeSseEvent({ type: 'text_message_content', messageId: 'm1', delta: 'x' });
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(frame.slice('data: '.length))).toMatchObject({ type: 'text_message_content' });
  });
});

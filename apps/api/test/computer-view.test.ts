// SPDX-License-Identifier: Apache-2.0
// Tests for the per-bot computer view (apps/api/src/computer-view.ts).
// Zero native deps: the OS layer is always an injected MockOSScreenLayer,
// frames use its fixture PNG. The WebSocket path is exercised with an
// in-process fake socket via hub.acceptSocket (same pattern as phone.ts).

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockOSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import type { OSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import { createComputerView } from '../src/computer-view.js';
import type { ComputerView, ComputerViewAuditEntry, ViewerSocket } from '../src/computer-view.js';

interface AuditCall {
  action: string;
  fields: Record<string, unknown>;
}

function makeHarness(opts: {
  auditEntries?: ComputerViewAuditEntry[];
  fps?: number;
  drivingWindowMs?: number;
} = {}): {
  view: ComputerView;
  audits: AuditCall[];
  layers: MockOSScreenLayer[];
  setAuditEntries: (e: ComputerViewAuditEntry[]) => void;
} {
  const audits: AuditCall[] = [];
  const layers: MockOSScreenLayer[] = [];
  let entries = opts.auditEntries ?? [];
  const createLayer = (_botId: string): OSScreenLayer => {
    const layer = new MockOSScreenLayer();
    layers.push(layer);
    return layer;
  };
  const view = createComputerView({
    audit: (action, fields) => {
      audits.push({ action, fields });
    },
    listAudit: () => entries,
    createLayer,
    fps: opts.fps ?? 200,
    drivingWindowMs: opts.drivingWindowMs ?? 10_000,
  });
  return { view, audits, layers, setAuditEntries: (e) => (entries = e) };
}

/** In-process fake viewer socket for acceptSocket(). */
function fakeViewer(): { sock: ViewerSocket; sent: string[]; emit: (text: string) => void; closeFromClient: () => void } {
  const sent: string[] = [];
  let msgCb: ((text: string) => void) | null = null;
  const closeCbs: Array<() => void> = [];
  const sock: ViewerSocket = {
    sendText: (text) => {
      sent.push(text);
    },
    close: () => {
      for (const cb of closeCbs) cb();
    },
    onMessage: (cb) => {
      msgCb = cb;
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
  };
  return {
    sock,
    sent,
    emit: (text) => msgCb?.(text),
    closeFromClient: () => {
      for (const cb of closeCbs) cb();
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('computer-view input API', () => {
  let baseUrl = '';
  let server: { close: (cb?: () => void) => void } | null = null;
  let view: ComputerView;
  let audits: AuditCall[];
  let layers: MockOSScreenLayer[];

  beforeEach(async () => {
    const h = makeHarness();
    view = h.view;
    audits = h.audits;
    layers = h.layers;
    const app = express();
    app.use(express.json());
    app.use('/api/computer', view.router);
    await new Promise<void>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve());
      server = s;
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    view.hub.stop();
    server?.close();
    server = null;
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> }));

  it('rejects a bad botId and unknown actions', async () => {
    const badBot = await post('/api/computer/input', { botId: 'no spaces!', action: 'click', x: 1, y: 1 });
    expect(badBot.status).toBe(400);
    expect(badBot.json['error']).toBe('bad_botId');
    const badAction = await post('/api/computer/input', { botId: 'bot-1', action: 'dance' });
    expect(badAction.status).toBe(400);
    expect(badAction.json['error']).toBe('bad_action');
    expect(audits).toHaveLength(0); // validation failures are not audited
  });

  it('clicks within bounds, records on the mock layer, and audits as the user', async () => {
    const r = await post('/api/computer/input', { botId: 'bot-1', action: 'click', x: 123.7, y: 456 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, action: 'click', x: 123, y: 456 });
    expect(layers).toHaveLength(1); // one session per bot
    expect(layers[0]!.callsOf('click')).toEqual([{ x: 123, y: 456 }]);
    // Second input reuses the same per-bot session (no new layer).
    await post('/api/computer/input', { botId: 'bot-1', action: 'click', x: 10, y: 10 });
    expect(layers).toHaveLength(1);

    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: 'tool.computer_viewer_action',
      fields: { actor: 'user', toolName: 'computer_click' },
    });
    const detail = audits[0]!.fields['detail'] as Record<string, unknown>;
    expect(detail).toMatchObject({ botId: 'bot-1', x: 123, y: 456, layer: 'mock' });
  });

  it('rejects out-of-bounds clicks and does not touch the layer', async () => {
    const r = await post('/api/computer/input', { botId: 'bot-1', action: 'click', x: 1920, y: 10 });
    expect(r.status).toBe(400);
    expect(r.json['error']).toBe('out_of_bounds');
    expect(layers).toHaveLength(1);
    expect(layers[0]!.callsOf('click')).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('types text within the cap and audits without storing raw text', async () => {
    const r = await post('/api/computer/input', { botId: 'bot-2', action: 'type', text: 'hello bot' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, typedChars: 9 });
    expect(layers[0]!.callsOf('type')).toEqual([{ text: 'hello bot' }]);
    const detail = audits[0]!.fields['detail'] as Record<string, unknown>;
    expect(detail).toMatchObject({ typedChars: 9 });
    expect(detail).not.toHaveProperty('text');

    const tooLong = await post('/api/computer/input', {
      botId: 'bot-2',
      action: 'type',
      text: 'x'.repeat(2001),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json['error']).toBe('text_too_long');
  });

  it('allowlist-checks keys', async () => {
    const ok = await post('/api/computer/input', { botId: 'bot-3', action: 'key', key: 'Enter' });
    expect(ok.status).toBe(200);
    expect(layers[0]!.callsOf('key')).toEqual([{ name: 'Enter' }]);
    const bad = await post('/api/computer/input', { botId: 'bot-3', action: 'key', key: 'F13' });
    expect(bad.status).toBe(400);
    expect(bad.json['error']).toBe('bad_key');
  });

  it('reports status with the mock flag, viewers, and geometry', async () => {
    const r = await fetch(`${baseUrl}/api/computer/status?botId=bot-9`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ ok: true, botId: 'bot-9', mock: true, viewers: 0, fps: 200, w: 1920, h: 1080 });
  });

  it('derives the agent-driving flag from recent computer_* audit events', async () => {
    const now = Date.now();
    const h = makeHarness({
      auditEntries: [
        { ts: now - 3000, actor: 'bot-7', action: 'tool.executed', toolName: 'computer_click' },
        { ts: now - 60_000, actor: 'bot-7', action: 'tool.executed', toolName: 'computer_key' },
        { ts: now - 3000, actor: 'bot-8', action: 'tool.executed', toolName: 'read_file' },
      ],
    });
    expect(h.view.hub.agentDriving('bot-7')).toBe(true); // click 3s ago
    expect(h.view.hub.agentDriving('bot-8')).toBe(false); // non-computer tool doesn't count
    h.view.hub.stop();
  });

  it('counts only computer_* tool events for the driving flag', async () => {
    const now = Date.now();
    const h = makeHarness({
      auditEntries: [
        { ts: now - 1000, actor: 'bot-9', action: 'tool.executed', toolName: 'read_file' },
        { ts: now - 60_000, actor: 'bot-9', action: 'tool.executed', toolName: 'computer_key' },
      ],
    });
    expect(h.view.hub.agentDriving('bot-9')).toBe(false);
    h.view.hub.stop();
  });

  it('counts the index.ts tool.computer_real_action hook for the driving flag', async () => {
    const now = Date.now();
    const h = makeHarness({
      auditEntries: [
        {
          ts: now - 2000,
          actor: 'agent',
          action: 'tool.computer_real_action',
          toolName: 'computer_click',
          detail: JSON.stringify({ botId: 'bot-5', x: 1, y: 2 }),
        },
      ],
    });
    expect(h.view.hub.agentDriving('bot-5')).toBe(true);
    expect(h.view.hub.agentDriving('bot-6')).toBe(false);
    h.view.hub.stop();
  });
});

describe('computer-view websocket', () => {
  let view: ComputerView;

  beforeEach(() => {
    view = makeHarness().view;
  });

  afterEach(() => {
    view.hub.stop();
  });

  it('rejects a bad botId and a botId mismatch, then closes', async () => {
    const v = fakeViewer();
    view.hub.acceptSocket(v.sock, 'bot-1');
    v.emit(JSON.stringify({ t: 'watch', botId: 'no spaces!' }));
    const msgs = v.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(msgs.some((m) => m.t === 'error' && m.detail === 'bad_botId')).toBe(true);

    const v2 = fakeViewer();
    let closed = false;
    v2.sock.onClose(() => (closed = true));
    view.hub.acceptSocket(v2.sock, 'bot-1');
    v2.emit(JSON.stringify({ t: 'watch', botId: 'bot-2' }));
    const msgs2 = v2.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(msgs2.some((m) => m.t === 'error' && m.detail === 'botId_mismatch')).toBe(true);
    expect(closed).toBe(true);
  });

  it('streams PNG frames after watch and stops the loop when the viewer leaves', async () => {
    const now = Date.now();
    const h = makeHarness({
      auditEntries: [{ ts: now, actor: 'bot-1', action: 'tool.executed', toolName: 'computer_click' }],
    });
    const v = fakeViewer();
    h.view.hub.acceptSocket(v.sock, 'bot-1');
    v.emit(JSON.stringify({ t: 'watch', botId: 'bot-1' }));

    await sleep(150);
    const msgs = v.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const ok = msgs.find((m) => m.t === 'ok');
    expect(ok).toMatchObject({ botId: 'bot-1', mock: true, w: 1920, h: 1080 });
    const frames = msgs.filter((m) => m.t === 'frame');
    expect(frames.length).toBeGreaterThan(0);
    const f = frames[0]!;
    expect(f['w']).toBe(1920);
    expect(f['h']).toBe(1080);
    // Mock fixture PNG is real PNG bytes -> base64 starts with the PNG magic.
    expect(typeof f['png']).toBe('string');
    expect((f['png'] as string).startsWith('iVBORw0KGgo')).toBe(true);
    expect(f['driving']).toBe(true); // computer_click 0s ago in the fake audit log
    expect(f['mock']).toBe(true);
    expect(f['n']).toBeGreaterThan(0);

    // Viewer leaves -> loop stops; no further frames accumulate.
    v.closeFromClient();
    const countAfterLeave = v.sent.length;
    await sleep(120);
    expect(v.sent.length).toBe(countAfterLeave);
    h.view.hub.stop();
  });
});

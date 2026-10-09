// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTeamRoutes } from '../src/teams-routes.js';
import { buildCoordinatorPrompt } from '@mvp/agent-runtime';
import type { AgentRuntime, BotConfig, StreamEvent } from '@mvp/agent-runtime';

void buildCoordinatorPrompt;

const bots = [
  { id: 'coord', name: 'Coordinator', description: 'leads', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: ['delegate'], mcpServers: [] },
  { id: 'coder', name: 'Coder', description: 'writes code', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
  { id: 'researcher', name: 'Researcher', description: 'researches', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

/** Fake coordinator turn: delegates one step to coder, then answers. */
function fakeRuntime(): AgentRuntime {
  return {
    runTurn: vi.fn(async ({ onEvent }: { onEvent: (e: StreamEvent) => Promise<void> }) => {
      await onEvent({ type: 'token', content: 'Working on it. ' });
      const call = { id: 'call-1', name: 'delegate', args: { task: 'write the code', bot: 'coder' } };
      await onEvent({ type: 'tool_call', call, approvalRequired: false });
      await onEvent({ type: 'tool_result', call, result: 'code written' });
      await onEvent({ type: 'token', content: 'Final answer here.' });
      await onEvent({ type: 'done', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
      return { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    }),
  } as unknown as AgentRuntime;
}

describe('teams router', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let agentRuntime: AgentRuntime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'teams-routes-'));
    agentRuntime = fakeRuntime();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerTeamRoutes(router, { dataDir: dir, agentRuntime, getBots: () => bots });
    app.use('/api/teams', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/teams`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function api(method: string, path = '', body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  it('validates team creation', async () => {
    expect((await api('POST', '', { name: 'T', coordinatorBotId: 'nope', memberBotIds: ['coder'] })).status).toBe(400);
    expect((await api('POST', '', { name: 'T', coordinatorBotId: 'coord', memberBotIds: [] })).status).toBe(400);
    expect((await api('POST', '', { name: 'T', coordinatorBotId: 'coord', memberBotIds: ['ghost'] })).status).toBe(400);
    expect((await api('POST', '', { name: 'T', coordinatorBotId: 'coord', memberBotIds: ['coord'] })).status).toBe(400);

    const created = await api('POST', '', { name: 'Crew', coordinatorBotId: 'coord', memberBotIds: ['coder', 'researcher'] });
    expect(created.status).toBe(200);
    const team = (created.json as { team: { id: string; name: string } }).team;
    expect(team.name).toBe('Crew');

    const listed = await api('GET', '');
    expect((listed.json as { teams: unknown[] }).teams).toHaveLength(1);

    expect((await api('DELETE', `/${team.id}`)).status).toBe(200);
    expect((await api('GET', '')).json).toEqual({ ok: true, teams: [] });
    expect((await api('DELETE', '/missing')).status).toBe(404);
  });

  it('runs a team task: coordinator delegates, steps stream, run finalizes', async () => {
    const created = await api('POST', '', { name: 'Crew', coordinatorBotId: 'coord', memberBotIds: ['coder'] });
    const team = (created.json as { team: { id: string } }).team;

    expect((await api('POST', `/${team.id}/run`, {})).status).toBe(400);
    const started = await api('POST', `/${team.id}/run`, { task: 'ship it' });
    expect(started.status).toBe(200);
    const run = (started.json as { run: { id: string; status: string } }).run;
    expect(run.status).toBe('running');

    // Collect SSE events until done.
    const streamRes = await fetch(`${baseUrl}/${team.id}/runs/${run.id}/stream`);
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const events: unknown[] = [];
    let buf = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (value) {
        buf += new TextDecoder().decode(value);
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
          }
        }
      }
      if (events.some((e) => (e as { kind: string }).kind === 'done')) break;
      if (done) break;
    }
    await reader.cancel();
    const kinds = events.map((e) => (e as { kind: string }).kind);
    // The run may finish before the stream connects; replay then emits the
    // step as step_done. Either way we must see the step and the finale.
    expect(kinds.some((k) => k === 'step_start' || k === 'step_done')).toBe(true);
    expect(kinds).toContain('done');
    const stepEvt = events.find((e) => {
      const k = (e as { kind: string }).kind;
      return k === 'step_start' || k === 'step_done';
    }) as {
      step: { memberBotId: string; memberName: string };
    };
    expect(stepEvt.step.memberBotId).toBe('coder');
    expect(stepEvt.step.memberName).toBe('Coder');
    const doneEvt = events.find((e) => (e as { kind: string }).kind === 'done') as { result: string };
    expect(doneEvt.result).toContain('Final answer here.');

    // Run history reflects the completed run.
    const history = await api('GET', `/${team.id}/runs`);
    const runs = (history.json as { runs: Array<{ id: string; status: string; steps: unknown[]; result: string }> }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('done');
    expect(runs[0].steps).toHaveLength(1);
    expect(runs[0].result).toContain('Final answer');

    const detail = await api('GET', `/${team.id}/runs/${run.id}`);
    expect((detail.json as { run: { status: string } }).run.status).toBe('done');
  });

  it('marks runs failed when the turn errors', async () => {
    const failing = {
      runTurn: vi.fn(async ({ onEvent }: { onEvent: (e: StreamEvent) => Promise<void> }) => {
        await onEvent({ type: 'error', message: 'model exploded' });
        return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      }),
    } as unknown as AgentRuntime;
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerTeamRoutes(router, { dataDir: dir, agentRuntime: failing, getBots: () => bots });
    app.use('/api/teams2', router);
    const srv = await new Promise<{ close(cb: () => void): void; address(): AddressInfo }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s as unknown as { close(cb: () => void): void; address(): AddressInfo }));
    });
    const url = `http://127.0.0.1:${srv.address().port}/api/teams2`;
    const post = (p: string, b?: unknown) =>
      fetch(`${url}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
      }).then(async (r) => ({ status: r.status, json: (await r.text().then((t) => (t ? JSON.parse(t) : null))) as unknown }));

    const created = await post('', { name: 'Crew', coordinatorBotId: 'coord', memberBotIds: ['coder'] });
    const team = (created.json as { team: { id: string } }).team;
    const started = await post(`/${team.id}/run`, { task: 'boom' });
    const run = (started.json as { run: { id: string } }).run;
    // Poll for failure (fire-and-forget turn).
    let status = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const d = await fetch(`${url}/${team.id}/runs/${run.id}`).then((r) => r.json() as Promise<{ run: { status: string } }>);
      status = d.run.status;
      if (status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe('failed');
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});

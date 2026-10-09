// SPDX-License-Identifier: Apache-2.0
// Peer-delegation approval for AgentTeams (workstream C):
//  - GET/PATCH /api/teams/:id/delegation-policy
//  - createDelegationGate behavior for all three policies (+ override)
//  - the coordinator run passes a delegateGate into runTurn

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegationGate,
  registerTeamRoutes,
  type DelegationApprovalBroker,
} from '../src/teams-routes.js';
import { TeamStore } from '@mvp/agent-runtime';
import type { AgentRuntime, BotConfig, DelegateGate, StreamEvent, ToolCall, ToolContext } from '@mvp/agent-runtime';

const bots = [
  { id: 'coord', name: 'Coordinator', description: 'leads', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: ['delegate'], mcpServers: [] },
  { id: 'coder', name: 'Coder', description: 'writes code', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
  { id: 'researcher', name: 'Researcher', description: 'researches', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

function fakeRuntime(): AgentRuntime {
  return {
    runTurn: vi.fn(async ({ onEvent }: { onEvent: (e: StreamEvent) => Promise<void> }) => {
      await onEvent({ type: 'done', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
      return { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    }),
  } as unknown as AgentRuntime;
}

/** Fake approval broker: scripted verdicts, records every minted approval. */
function fakeBroker(verdicts: Array<'approved' | 'denied'> = ['approved']): DelegationApprovalBroker & {
  minted: Array<{ toBotId: string; policy: string }>;
} {
  const minted: Array<{ toBotId: string; policy: string }> = [];
  return {
    minted,
    requestPeerDelegationApproval: async (args: { toBotId: string; policy: string }) => {
      minted.push({ toBotId: args.toBotId, policy: String(args.policy) });
      return `approval-${minted.length}`;
    },
    awaitDecision: async () => verdicts.shift() ?? 'denied',
  };
}

const delegateCall = (bot?: string): ToolCall => ({
  id: 'call-1',
  name: 'delegate',
  args: bot ? { task: 'do it', bot } : { task: 'do it myself' },
});
const ctx: ToolContext = { sessionId: 'team_x_run1', botId: 'coord' };

describe('delegation policy endpoints', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'teams-delegation-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerTeamRoutes(router, { dataDir: dir, agentRuntime: fakeRuntime(), getBots: () => bots });
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

  async function api(method: string, path = '', body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async function makeTeam(policy?: string): Promise<string> {
    const r = await api('POST', '', {
      name: 'T',
      coordinatorBotId: 'coord',
      memberBotIds: ['coder', 'researcher'],
      ...(policy ? { delegationPolicy: policy } : {}),
    });
    expect(r.status).toBe(200);
    return r.json.team.id as string;
  }

  it('defaults to approve-once-per-team', async () => {
    const id = await makeTeam();
    const r = await api('GET', `/${id}/delegation-policy`);
    expect(r.status).toBe(200);
    expect(r.json.delegationPolicy).toBe('approve-once-per-team');
    expect(r.json.delegationPolicyOverrides).toEqual({});
  });

  it('accepts a policy at creation time', async () => {
    const id = await makeTeam('always-ask');
    const r = await api('GET', `/${id}/delegation-policy`);
    expect(r.json.delegationPolicy).toBe('always-ask');
  });

  it('rejects an invalid policy at creation', async () => {
    const r = await api('POST', '', {
      name: 'T',
      coordinatorBotId: 'coord',
      memberBotIds: ['coder'],
      delegationPolicy: 'sometimes',
    });
    expect(r.status).toBe(400);
  });

  it('PATCH updates the policy', async () => {
    const id = await makeTeam();
    const r = await api('PATCH', `/${id}/delegation-policy`, { delegationPolicy: 'always-allow' });
    expect(r.status).toBe(200);
    expect(r.json.team.delegationPolicy).toBe('always-allow');
    const g = await api('GET', `/${id}/delegation-policy`);
    expect(g.json.delegationPolicy).toBe('always-allow');
  });

  it('PATCH rejects invalid policy values', async () => {
    const id = await makeTeam();
    const r = await api('PATCH', `/${id}/delegation-policy`, { delegationPolicy: 'yolo' });
    expect(r.status).toBe(400);
  });

  it('PATCH accepts per-bot overrides, rejects non-members and bad values', async () => {
    const id = await makeTeam();
    const ok = await api('PATCH', `/${id}/delegation-policy`, {
      delegationPolicyOverrides: { coder: 'always-allow' },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.team.delegationPolicyOverrides).toEqual({ coder: 'always-allow' });

    const nonMember = await api('PATCH', `/${id}/delegation-policy`, {
      delegationPolicyOverrides: { stranger: 'always-allow' },
    });
    expect(nonMember.status).toBe(400);

    const badValue = await api('PATCH', `/${id}/delegation-policy`, {
      delegationPolicyOverrides: { coder: 'yolo' },
    });
    expect(badValue.status).toBe(400);
  });

  it('PATCH on an unknown team 404s', async () => {
    const r = await api('PATCH', '/nope/delegation-policy', { delegationPolicy: 'always-ask' });
    expect(r.status).toBe(404);
    const g = await api('GET', '/nope/delegation-policy');
    expect(g.status).toBe(404);
  });
});

describe('createDelegationGate', () => {
  let dir: string;
  let store: TeamStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teams-gate-'));
    store = new TeamStore(dir);
  });

  function makeTeam(policy?: 'approve-once-per-team' | 'always-ask' | 'always-allow'): string {
    const team = store.createTeam('T', 'coord', ['coder', 'researcher']);
    if (policy) store.setDelegationPolicy(team.id, policy);
    return team.id;
  }

  it('always-allow: never asks the broker', async () => {
    const broker = fakeBroker();
    const gate = createDelegationGate(makeTeam('always-allow'), { store, broker });
    expect(await gate(delegateCall('coder'), ctx)).toEqual({ decision: 'allow' });
    expect(broker.minted).toHaveLength(0);
  });

  it('always-ask: asks on every delegation; denied aborts with a clear message', async () => {
    const broker = fakeBroker(['approved', 'denied']);
    const teamId = makeTeam('always-ask');
    const gate = createDelegationGate(teamId, { store, broker });
    expect(await gate(delegateCall('coder'), ctx)).toEqual({ decision: 'allow' });
    const denied = await gate(delegateCall('researcher'), ctx);
    expect(denied.decision).toBe('deny');
    if (denied.decision === 'deny') {
      expect(denied.reason).toMatch(/not approved/i);
      expect(denied.reason).toContain('researcher');
    }
    expect(broker.minted).toHaveLength(2);
    // always-ask records no grant.
    expect(store.hasDelegationGrant(teamId)).toBe(false);
  });

  it('approve-once-per-team: one approval covers subsequent delegations', async () => {
    const broker = fakeBroker(['approved']);
    const teamId = makeTeam(); // default policy
    const gate = createDelegationGate(teamId, { store, broker });
    expect(await gate(delegateCall('coder'), ctx)).toEqual({ decision: 'allow' });
    expect(store.hasDelegationGrant(teamId)).toBe(true);
    // Second delegation (different member) needs no new approval.
    expect(await gate(delegateCall('researcher'), ctx)).toEqual({ decision: 'allow' });
    expect(broker.minted).toHaveLength(1);
  });

  it('approve-once-per-team: a denial asks again next time', async () => {
    const broker = fakeBroker(['denied', 'approved']);
    const teamId = makeTeam();
    const gate = createDelegationGate(teamId, { store, broker });
    const first = await gate(delegateCall('coder'), ctx);
    expect(first.decision).toBe('deny');
    expect(store.hasDelegationGrant(teamId)).toBe(false);
    expect(await gate(delegateCall('coder'), ctx)).toEqual({ decision: 'allow' });
    expect(broker.minted).toHaveLength(2);
  });

  it('per-bot override wins over the team policy', async () => {
    const broker = fakeBroker(['approved']);
    const teamId = makeTeam('always-ask');
    store.setDelegationPolicy(teamId, 'always-ask', { coder: 'always-allow' });
    const gate = createDelegationGate(teamId, { store, broker });
    expect(await gate(delegateCall('coder'), ctx)).toEqual({ decision: 'allow' });
    expect(broker.minted).toHaveLength(0); // override skipped the broker
    expect(await gate(delegateCall('researcher'), ctx)).toEqual({ decision: 'allow' });
    expect(broker.minted).toHaveLength(1); // team policy asked once
  });

  it('self-delegation (no peer) is always allowed without asking', async () => {
    const broker = fakeBroker();
    const gate = createDelegationGate(makeTeam('always-ask'), { store, broker });
    expect(await gate(delegateCall(), ctx)).toEqual({ decision: 'allow' });
    expect(await gate(delegateCall('coord'), ctx)).toEqual({ decision: 'allow' });
    expect(broker.minted).toHaveLength(0);
  });

  it('without a broker the gate allows (with a warning) instead of breaking runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const gate = createDelegationGate(makeTeam('always-ask'), { store });
      expect(await gate(delegateCall('coder'), ctx)).toEqual({ decision: 'allow' });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a broker failure fails closed (deny)', async () => {
    const broken: DelegationApprovalBroker = {
      requestPeerDelegationApproval: async () => {
        throw new Error('broker down');
      },
      awaitDecision: async () => 'approved',
    };
    const gate = createDelegationGate(makeTeam('always-ask'), { store, broker: broken });
    const verdict = await gate(delegateCall('coder'), ctx);
    expect(verdict.decision).toBe('deny');
  });
});

describe('coordinator run wiring', () => {
  it('passes a delegateGate into runTurn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teams-wiring-'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    let capturedGate: DelegateGate | undefined;
    const runtime = {
      runTurn: vi.fn(async (opts: { delegateGate?: DelegateGate; onEvent: (e: StreamEvent) => Promise<void> }) => {
        capturedGate = opts.delegateGate;
        await opts.onEvent({ type: 'done', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
        return { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
      }),
    } as unknown as AgentRuntime;
    registerTeamRoutes(router, {
      dataDir: dir,
      agentRuntime: runtime,
      getBots: () => bots,
      delegationBroker: fakeBroker(),
    });
    app.use('/api/teams', router);
    const server = await new Promise<{ close(cb: () => void): void }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s as unknown as { close(cb: () => void): void }));
    });
    try {
      const addr = (server as unknown as { address(): AddressInfo }).address();
      const base = `http://127.0.0.1:${addr.port}/api/teams`;
      const created = await (
        await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'T', coordinatorBotId: 'coord', memberBotIds: ['coder'] }),
        })
      ).json();
      const runRes = await fetch(`${base}/${created.team.id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'do the thing' }),
      });
      expect(runRes.status).toBe(200);
      // executeRun is fire-and-forget; wait a tick for runTurn to be invoked.
      await new Promise((r) => setTimeout(r, 50));
      expect(capturedGate).toBeTypeOf('function');
      // The wired gate enforces the default policy end-to-end.
      const verdict = await capturedGate!(delegateCall('coder'), ctx);
      expect(verdict).toEqual({ decision: 'allow' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

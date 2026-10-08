// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GovernanceGateway } from '@mvp/governance';
import {
  MarketplaceInstaller,
  MarketplaceRegistry,
  RevenueLedger,
} from '@mvp/marketplace';
import { registerMarketplaceRoutes } from '../src/marketplace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', '..', '..', 'packages', 'marketplace', 'registry', 'registry.json');

interface StubApproval {
  id: string;
  toolName: string;
  status: 'pending' | 'approved' | 'denied';
}

function stubGovernance() {
  const approvals = new Map<string, StubApproval>();
  let n = 0;
  return {
    approvals,
    gateway: {
      requestApproval: (toolName: string) => {
        const id = `appr_test_${++n}`;
        approvals.set(id, { id, toolName, status: 'pending' });
        return id;
      },
      getApproval: (id: string) => approvals.get(id),
    } as unknown as GovernanceGateway,
  };
}

describe('marketplace router', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let gov: ReturnType<typeof stubGovernance>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'marketplace-routes-'));
    gov = stubGovernance();
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerMarketplaceRoutes(router, {
      config: {} as never,
      governance: gov.gateway,
      dataDir: dir,
      registry: MarketplaceRegistry.fromFile(REGISTRY),
      installer: new MarketplaceInstaller(join(dir, 'marketplace')),
      revenue: new RevenueLedger(join(dir, 'marketplace.db')),
    });
    app.use('/api/marketplace', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/marketplace`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(method: string, path = '', body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it('browses entries with kind/query filters', async () => {
    const all = (await api('GET')).json as unknown[];
    expect(all.length).toBeGreaterThan(0);
    const bots = (await api('GET', '?kind=bot')).json as { kind: string }[];
    expect(bots.length).toBeGreaterThan(0);
    expect(bots.every((b) => b.kind === 'bot')).toBe(true);
    expect(((await api('GET', '?kind=bogus')).status)).toBe(400);
    const one = await api('GET', '/git-hygiene');
    expect(one.status).toBe(200);
    expect(((await api('GET', '/nope')).status)).toBe(404);
  });

  it('installs bots/skills/workflows directly and records revenue installs', async () => {
    const res = await api('POST', '/meeting-scribe/install');
    expect(res.status).toBe(201);
    expect((res.json as { gated: boolean }).gated).toBe(false);
    const rev = await api('GET', '/revenue/creators');
    const creators = (rev.json as { creators: { creator: string; installs: number }[] }).creators;
    const labs = creators.find((c) => c.creator === 'mvp-labs');
    expect(labs?.installs).toBeGreaterThanOrEqual(1);
  });

  it('gates MCP installs behind the governance approval inbox (deny-by-default)', async () => {
    const gated = await api('POST', '/postgres-local/install');
    expect(gated.status).toBe(202);
    const { approvalId } = gated.json as { approvalId: string };
    expect(approvalId).toBeTruthy();

    // Denied approval → 403, nothing installed.
    gov.approvals.get(approvalId)!.status = 'denied';
    const denied = await api('POST', '/postgres-local/install/confirm', { approvalId });
    expect(denied.status).toBe(403);

    // Approve → confirm completes the install.
    const gated2 = await api('POST', '/postgres-local/install');
    const approvalId2 = (gated2.json as { approvalId: string }).approvalId;
    gov.approvals.get(approvalId2)!.status = 'approved';
    const done = await api('POST', '/postgres-local/install/confirm', { approvalId: approvalId2 });
    expect(done.status).toBe(201);
    expect((done.json as { gated: boolean }).gated).toBe(true);
  });

  it('rejects confirm for unknown or pending approvals', async () => {
    expect((await api('POST', '/postgres-local/install/confirm', { approvalId: 'nope' })).status).toBe(404);
    const gated = await api('POST', '/postgres-local/install');
    const { approvalId } = gated.json as { approvalId: string };
    // Still pending → 403 fail closed.
    expect((await api('POST', '/postgres-local/install/confirm', { approvalId })).status).toBe(403);
    expect((await api('POST', '/meeting-scribe/install/confirm', { approvalId })).status).toBe(400);
  });

  it('records creator usage and exposes per-creator revenue', async () => {
    expect((await api('POST', '/revenue/usage', { creator: 'dataforge', entryId: 'sql-tuner', tokens: 2500 })).status).toBe(201);
    expect((await api('POST', '/revenue/usage', { tokens: 1 })).status).toBe(400);
    const one = await api('GET', '/revenue/creators/dataforge');
    expect(one.status).toBe(200);
    expect((one.json as { summary: { usageTokens: number } }).summary.usageTokens).toBe(2500);
  });
});

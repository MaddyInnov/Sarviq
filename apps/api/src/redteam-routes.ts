// SPDX-License-Identifier: Apache-2.0
// Red-team robustness suite HTTP API (defensive testing harness — see
// packages/redteam/README.md for the hard boundary). Mounted by the
// integrator (routes.ts), e.g.:
//
//   import { registerRedteamRoutes } from './redteam-routes.js';
//   registerRedteamRoutes(router, {
//     dataDir: config.dataDir,
//     agentRuntime,
//     bots,
//   });
//
// Routes (mounted at /api):
//   POST /bots/:id/redteam/run     → { suite? } → RedTeamReport (persisted)
//   GET  /bots/:id/redteam/reports  → RedTeamReport[] (oldest first)

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentRuntime, BotConfig } from '@mvp/agent-runtime';
import {
  AgentRuntimeRunner,
  getSuite,
  latestReport,
  listReports,
  listSuites,
  runSuite,
  saveReport,
} from '@mvp/redteam';

export interface RedteamDeps {
  dataDir: string;
  agentRuntime: AgentRuntime;
  bots: BotConfig[];
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerRedteamRoutes(router: Router, deps: RedteamDeps): void {
  const { dataDir, agentRuntime, bots } = deps;

  router.get('/bots/:id/redteam/reports', (req: Request, res: Response) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody('bot not found'));
      return;
    }
    try {
      res.json({ ok: true, botId: bot.id, reports: listReports(dataDir, bot.id) });
    } catch (err) {
      res.status(500).json(errorBody('failed to load redteam reports', errMessage(err)));
    }
  });

  router.post('/bots/:id/redteam/run', async (req: Request, res: Response) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody('bot not found'));
      return;
    }
    const body = (req.body ?? {}) as { suite?: unknown };
    const suite = typeof body.suite === 'string' && body.suite ? body.suite : 'core';
    try {
      getSuite(suite); // throws on unknown suite → 400 below
    } catch {
      res
        .status(400)
        .json(errorBody(`unknown redteam suite: ${suite}`, `known suites: ${listSuites().join(', ')}`));
      return;
    }
    try {
      // NOTE: this runs the suite against the real bot through runTurn.
      // Destructive tool calls are governed by the platform's hard floors
      // (catastrophic = denied unconditionally); approval waits fail closed
      // quickly via AgentRuntimeRunner's short approvalTimeoutMs.
      const runner = new AgentRuntimeRunner(agentRuntime, bot);
      const report = await runSuite(runner, { id: bot.id, name: bot.name, systemPrompt: bot.systemPrompt }, suite);
      saveReport(dataDir, report);
      res.json({ ok: true, report });
    } catch (err) {
      res.status(500).json(errorBody('redteam suite run failed', errMessage(err)));
    }
  });

  // Convenience: latest report without the full history.
  router.get('/bots/:id/redteam/latest', (req: Request, res: Response) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody('bot not found'));
      return;
    }
    res.json({ ok: true, botId: bot.id, report: latestReport(dataDir, bot.id) });
  });
}

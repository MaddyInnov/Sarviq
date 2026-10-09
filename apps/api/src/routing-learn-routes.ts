// SPDX-License-Identifier: Apache-2.0
// Learning-from-corrections routing HTTP API (feature #4: corrections
// actually update routing).
//
//   GET  /api/routing/rules         → { ok, rules } (learned rules, newest first)
//   POST /api/routing/corrections   → { taskType, routedProviderId, routedModelId,
//                                       correctedProviderId, correctedModelId,
//                                       message? } → { ok, rules }
//
// The chat route loads the stored rules via loadRoutingRules() and passes
// them into runTurn({ routingRules }) — which routeModel() honors — so a
// correction recorded here changes future routing decisions. Learning is
// fully local (pattern → rule template), no LLM, no network.
//
// Mounted by the integrator (routes.ts), e.g.:
//
//   import { registerRoutingLearnRoutes } from './routing-learn-routes.js';
//   const rlRouter = express.Router();
//   registerRoutingLearnRoutes(rlRouter, { dataDir: config.dataDir });
//   router.use('/routing', rlRouter);

import type { Request, Response, Router } from 'express';
import {
  loadRoutingRules,
  recordRoutingCorrection,
  type RoutingCorrection,
} from '@mvp/agent-runtime';

export interface RoutingLearnRouteDeps {
  dataDir: string;
}

const TASK_TYPES = new Set(['code', 'chat', 'reasoning', 'simple-qa']);

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new Error(`"${name}" must be a non-empty string (max 200 chars).`);
  }
  return value.trim();
}

/** Validate a correction body; throws on the first problem. */
export function parseCorrectionBody(body: unknown): RoutingCorrection {
  const b = (body ?? {}) as Record<string, unknown>;
  const taskType = b.taskType;
  if (typeof taskType !== 'string' || !TASK_TYPES.has(taskType)) {
    throw new Error('"taskType" must be one of: code, chat, reasoning, simple-qa.');
  }
  const correction: RoutingCorrection = {
    taskType: taskType as RoutingCorrection['taskType'],
    routedProviderId: requiredId(b.routedProviderId, 'routedProviderId'),
    routedModelId: requiredId(b.routedModelId, 'routedModelId'),
    correctedProviderId: requiredId(b.correctedProviderId, 'correctedProviderId'),
    correctedModelId: requiredId(b.correctedModelId, 'correctedModelId'),
  };
  if (typeof b.message === 'string' && b.message.trim() !== '') {
    correction.message = b.message.slice(0, 4000);
  }
  return correction;
}

export function registerRoutingLearnRoutes(router: Router, deps: RoutingLearnRouteDeps): void {
  router.get('/rules', (_req: Request, res: Response) => {
    try {
      const rules = loadRoutingRules(deps.dataDir);
      res.json({ ok: true, rules });
    } catch (err) {
      res.status(500).json(errorBody('Failed to load routing rules', errMessage(err)));
    }
  });

  router.post('/corrections', (req: Request, res: Response) => {
    let correction: RoutingCorrection;
    try {
      correction = parseCorrectionBody(req.body);
    } catch (err) {
      res.status(400).json(errorBody('Invalid correction', errMessage(err)));
      return;
    }
    try {
      const rules = recordRoutingCorrection(deps.dataDir, correction);
      res.status(201).json({ ok: true, rules });
    } catch (err) {
      res.status(500).json(errorBody('Failed to record correction', errMessage(err)));
    }
  });
}

export default registerRoutingLearnRoutes;

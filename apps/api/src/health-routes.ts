// SPDX-License-Identifier: Apache-2.0
// Run health scoring + regression detection (features #2/#5).
//
// Scores every workflow run and bot turn as Good / Needs work / Poor with a
// plain-language diagnosis and suggested fix attached (template-generated —
// no LLM, no network). Scores persist in SQLite alongside the run records;
// terminal runs/turns also append a metric sample that feeds the 7-day
// regression detector. Alerts surface via GET /api/health/regressions and
// (once the briefing backend emits them) via the briefing payload's
// `regressions` section — the briefing panel already renders either source.

import express from 'express';
import type { WorkflowRun, WorkflowRunner } from '@mvp/workflows';
import { detectRegressions, scoreTurn, scoreWorkflowRun } from '@mvp/run-health';
import type { MetricSample, RunHealth, RunHealthStore, TurnHealth, TurnTelemetry } from '@mvp/run-health';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rolling baseline window for health scoring (token/latency baselines). */
const HEALTH_BASELINE_DAYS = 30;

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRun['status']> = new Set(['succeeded', 'failed']);

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export interface HealthRouteDeps {
  workflowRunner: WorkflowRunner;
  runHealth: RunHealthStore;
}

/**
 * Scoring helpers shared by these routes, the workflow run payloads, and
 * the /chat turn hook in routes.ts.
 */
export function createHealthScoring(runHealth: RunHealthStore) {
  /**
   * Score a workflow run, persisting the score and a metric sample for
   * terminal runs (regression history). In-flight runs are scored fresh on
   * every read — persisting them would freeze a stale verdict.
   */
  const scoreAndPersistRun = (run: WorkflowRun): RunHealth => {
    const cached = runHealth.getRunHealth(run.id);
    if (cached) return cached;
    const baselines = runHealth.scopeBaselines('workflow', run.workflowId, Date.now() - HEALTH_BASELINE_DAYS * DAY_MS);
    const health = scoreWorkflowRun(run, { baselines });
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      runHealth.saveRunHealth(health);
      runHealth.recordMetric({
        scopeKind: 'workflow',
        scopeId: run.workflowId,
        ts: Date.now(),
        latencyMs: health.latencyMs,
        errored: run.status === 'failed',
        runId: run.id,
      });
    }
    return health;
  };

  /** Score + persist one bot turn's telemetry; metrics must never break chat. */
  const recordTurnHealth = (telemetry: TurnTelemetry): TurnHealth => {
    const baselines = runHealth.scopeBaselines('bot', telemetry.botId, Date.now() - HEALTH_BASELINE_DAYS * DAY_MS);
    const health = scoreTurn(telemetry, { baselines });
    runHealth.saveTurnHealth(health);
    runHealth.recordMetric({
      scopeKind: 'bot',
      scopeId: telemetry.botId,
      ts: Date.now(),
      latencyMs: telemetry.latencyMs,
      errored: telemetry.errored,
      tokens: telemetry.totalTokens || undefined,
    });
    return health;
  };

  return { scoreAndPersistRun, recordTurnHealth };
}

/** Mount the /api/health/* routes. */
export function registerHealthRoutes(router: express.Router, deps: HealthRouteDeps): void {
  const { workflowRunner, runHealth } = deps;
  const { scoreAndPersistRun, recordTurnHealth } = createHealthScoring(runHealth);

  router.get('/health/runs/:runId', (req, res) => {
    try {
      const run = workflowRunner.getRun(req.params.runId);
      if (!run) {
        res.status(404).json(errorBody(`Unknown run "${req.params.runId}"`));
        return;
      }
      res.json(scoreAndPersistRun(run));
    } catch (err) {
      res.status(500).json(errorBody('Failed to score workflow run', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/health/turns', (req, res) => {
    const body = (req.body ?? {}) as Partial<TurnTelemetry>;
    if (typeof body.botId !== 'string' || !body.botId) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (typeof body.latencyMs !== 'number' || typeof body.totalTokens !== 'number' || typeof body.errored !== 'boolean') {
      res.status(400).json(errorBody('latencyMs (number), totalTokens (number) and errored (boolean) are required'));
      return;
    }
    try {
      const telemetry: TurnTelemetry = {
        botId: body.botId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        latencyMs: body.latencyMs,
        totalTokens: body.totalTokens,
        errored: body.errored,
        errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage : undefined,
        toolRetries: typeof body.toolRetries === 'number' ? body.toolRetries : undefined,
        emptyResponse: body.emptyResponse === true,
      };
      res.json(recordTurnHealth(telemetry));
    } catch (err) {
      res.status(500).json(errorBody('Failed to score bot turn', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/health/turns', (req, res) => {
    try {
      const botId = typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : undefined;
      res.json(runHealth.listTurnHealth(botId, 50));
    } catch (err) {
      res.status(500).json(errorBody('Failed to list turn health', err instanceof Error ? err.message : String(err)));
    }
  });

  // Regression detection: last 7 days vs the prior 7 per bot/workflow on p50
  // latency, error rate, and cost per run. Thresholds (documented in
  // packages/run-health/src/regressions.ts): >30% worse, >=10 samples per
  // window, >=2pp absolute guard for error rate.
  router.get('/health/regressions', (_req, res) => {
    try {
      const now = Date.now();
      const from = now - 14 * DAY_MS;
      const samples: MetricSample[] = [];
      for (const scope of runHealth.listScopes()) {
        samples.push(...runHealth.queryMetrics(scope.scopeKind, scope.scopeId, from, now));
      }
      res.json({
        generatedAt: now,
        windowDays: 7,
        thresholdPct: 30,
        minSamples: 10,
        regressions: detectRegressions(samples, { now }),
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to detect regressions', err instanceof Error ? err.message : String(err)));
    }
  });
}

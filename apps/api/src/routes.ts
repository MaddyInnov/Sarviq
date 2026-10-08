// SPDX-License-Identifier: Apache-2.0
// HTTP routes for the MVP API. Mounted at /api by src/index.ts.
//
// Package wiring:
// - @mvp/governance (real class) serves the approvals/audit endpoints.
// - @mvp/agent-runtime drives chat via a GovernanceAdapter (see
//   governance-adapter.ts), which bridges the runtime's expected governance
//   surface to the real gateway — including the runtime-generated approval
//   id → real approval id translation.

import express from 'express';
import { BotMemoryStore, isFreeModel, listProviderPresets, resolveApiKey } from '@mvp/agent-runtime';
import type { AgentRuntime, BotConfig, StreamEvent } from '@mvp/agent-runtime';
// pricing.ts is not re-exported from the agent-runtime index (index untouched);
// import the built subpath directly.
import { priceOfModel } from '@mvp/agent-runtime/dist/pricing.js';
import type { ApprovalStatus, GovernanceGateway } from '@mvp/governance';
import type { WorkflowRun, WorkflowRunner } from '@mvp/workflows';
import type { AppConfig } from './config.js';
import type { GovernanceAdapter } from './governance-adapter.js';
import type { McpConnection } from './tool-registry.js';
import { saveBotPolicy } from './bot-policies.js';
// Phase 3: connected apps (OAuth), messaging gateway, notes, tasks/calendar.
import { registerOAuthRoutes } from './oauth.js';
import { registerMessagingRoutes } from './messaging.js';
import { registerNotesRoutes } from './notes.js';
import { registerTasksRoutes } from './tasks.js';
import {
  connectBridge,
  disconnectBridge,
  isKnownProviderId,
  listProviders,
  removeProviderKey,
  saveProviderKey,
} from './providers.js';
import type {
  ApiError,
  ChatRequestBody,
  DecideApprovalBody,
  DryRunBody,
  ProviderKeyBody,
  RunWorkflowBody,
} from './types.js';

export interface RouteDeps {
  config: AppConfig;
  bots: BotConfig[];
  agentRuntime: AgentRuntime;
  /** Real governance gateway (approvals/audit endpoints). */
  governance: GovernanceGateway;
  /** Adapter bridging the runtime's governance surface to the real gateway. */
  governanceAdapter: GovernanceAdapter;
  workflowRunner: WorkflowRunner;
  mcpConnections: McpConnection[];
  /**
   * Phase 3: two-way MCP server bridge (set by index.ts when MCP_SERVER_PORT
   * is configured). Lets the approvals inbox close the loop on approvals
   * that originated from external MCP clients.
   */
  mcpServer?: { decideApproval(approvalId: string, decision: 'approved' | 'denied'): void };
}

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRun['status']> = new Set(['succeeded', 'failed']);
const VALID_APPROVAL_STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'denied', 'expired']);

function errorBody(error: string, detail?: string): ApiError {
  return detail ? { error, detail } : { error };
}

function isConfiguredSafe(providerId: string): boolean {
  try {
    return Boolean(resolveApiKey(providerId));
  } catch {
    return false;
  }
}

/** Serialize a StreamEvent for SSE. Never throws; never leaks non-JSON values. */
function serializeEvent(event: StreamEvent): string {
  try {
    return JSON.stringify(event);
  } catch {
    return JSON.stringify({ type: 'error', message: 'Failed to serialize agent event' });
  }
}

function sseHeaders(res: express.Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

/** Normalize an optional model override: empty string falls back to undefined. */
export function createRouter(deps: RouteDeps): express.Router {
  const router = express.Router();
  const { config, bots, agentRuntime, governance, governanceAdapter, workflowRunner } = deps;

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      groqConfigured: isConfiguredSafe('groq'),
      openRouterConfigured: isConfiguredSafe('openrouter'),
    });
  });

  router.get('/bots', (_req, res) => {
    // Bot configs carry no secrets (system prompts are content, not keys).
    res.json(bots);
  });

  // ---- Per-bot governance policy ------------------------------------------
  // PUT body: { rules: [{ id, toolPattern, effect: 'allow'|'deny'|'require-approval', reason? }] }.
  // Persisted to <dataDir>/bot-policies.json and applied to the in-memory
  // bot immediately; also applied at boot (see bot-policies.ts).
  router.put('/bots/:id/policy', (req, res) => {
    const body = (req.body ?? {}) as { rules?: unknown };
    try {
      const policy = saveBotPolicy(config.dataDir, bots, req.params.id, body.rules);
      res.json({ ok: true, botId: req.params.id, policy });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith('Unknown bot') ? 404 : 400;
      res.status(status).json(errorBody('Failed to save bot policy', message));
    }
  });

  // ---- Per-bot persistent memory ----------------------------------------
  // Phase 2: each bot's long-term memory lives at <dataDir>/memories/<botId>.md
  // (see BotMemoryStore). The bots also maintain it themselves via the
  // memory_recall / memory_store tools; these endpoints back the Workspace UI.
  router.get('/bots/:id/memory', (req, res) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody('Unknown bot', req.params.id));
      return;
    }
    res.json({ botId: bot.id, content: new BotMemoryStore(config.dataDir).read(bot.id) });
  });

  router.put('/bots/:id/memory', (req, res) => {
    const bot = bots.find((b) => b.id === req.params.id);
    if (!bot) {
      res.status(404).json(errorBody('Unknown bot', req.params.id));
      return;
    }
    const body = (req.body ?? {}) as { content?: unknown };
    if (typeof body.content !== 'string') {
      res.status(400).json(errorBody('Body must be { content: string }'));
      return;
    }
    new BotMemoryStore(config.dataDir).replace(bot.id, body.content);
    res.json({ ok: true, botId: bot.id });
  });

  // ---- Chat (SSE) -------------------------------------------------------
  // The stream stays open while approvals are pending: the agent loop awaits
  // governance decisions, and the client decides via POST /api/approvals/:id.
  // Heartbeat comment every 15s keeps proxies from closing idle streams.
  router.post('/chat', async (req, res) => {
    const body = (req.body ?? {}) as Partial<ChatRequestBody>;
    if (typeof body.botId !== 'string' || !body.botId) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json(errorBody('message is required'));
      return;
    }
    const bot = bots.find((b) => b.id === body.botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${body.botId}"`));
      return;
    }

    sseHeaders(res);
    let closed = false;
    let terminalEmitted = false;
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);
    const finish = () => {
      clearInterval(heartbeat);
      if (!closed) {
        closed = true;
        res.end();
      }
    };
    // NOTE: listen on the RESPONSE, not the request: under Bun's node:http
    // compat layer req 'close' can fire as soon as the request body is
    // consumed, which would wrongly kill long-lived SSE streams.
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
    });

    const onEvent = async (event: StreamEvent): Promise<void> => {
      if (closed) return;
      if (event.type === 'done' || event.type === 'error') terminalEmitted = true;
      res.write(`data: ${serializeEvent(event)}\n\n`);
    };

    try {
      // Phase 3: pass the RAW explicit values (no bot-default merging here).
      // runTurn applies bot defaults, then smart model routing when nothing
      // is pinned; taskType selects the routing profile.
      const rawTaskType = body.taskType;
      const taskType =
        rawTaskType === 'code' || rawTaskType === 'chat' || rawTaskType === 'reasoning' || rawTaskType === 'simple-qa'
          ? rawTaskType
          : undefined;
      await agentRuntime.runTurn({
        bot,
        message: body.message,
        sessionId: body.sessionId,
        providerId: typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined,
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
        taskType,
        onEvent,
      });
      // The runtime should emit done/error itself; emit a terminal event only
      // if it resolved without one so clients never hang.
      if (!terminalEmitted && !closed) {
        res.write(`data: ${JSON.stringify({ type: 'done', usage: null })}\n\n`);
      }
    } catch (err) {
      if (!terminalEmitted && !closed) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      }
    } finally {
      finish();
    }
  });

  // ---- Approvals ----------------------------------------------------------
  // :id accepts either the runtime-issued approval id (from the chat SSE
  // `approval_required` event) or the real gateway id (from the inbox) —
  // the adapter translates.
  router.get('/approvals', (req, res) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (statusParam && !VALID_APPROVAL_STATUSES.has(statusParam)) {
        res.status(400).json(
          errorBody(`Invalid status "${statusParam}" — expected pending|approved|denied|expired`),
        );
        return;
      }
      res.json(governance.listApprovals(statusParam as ApprovalStatus | undefined));
    } catch (err) {
      res.status(500).json(errorBody('Failed to list approvals', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/approvals/:id', (req, res) => {
    const body = (req.body ?? {}) as Partial<DecideApprovalBody>;
    if (body.decision !== 'approved' && body.decision !== 'denied') {
      res.status(400).json(errorBody('decision must be "approved" or "denied"'));
      return;
    }
    try {
      const realId = governanceAdapter.resolveApprovalId(req.params.id);
      const existing = governance.getApproval(realId);
      if (!existing) {
        res.status(404).json(errorBody(`Unknown approval "${req.params.id}"`));
        return;
      }
      if (existing.status !== 'pending') {
        res.status(409).json(errorBody(`Approval "${req.params.id}" is already ${existing.status}`));
        return;
      }
      const decided = governance.decide(realId, body.decision, { note: body.note });
      // Phase 3: close the loop for approvals that originated from external
      // MCP clients — the platform MCP server holds the pending call and
      // mints the single-use grant on decision.
      if (deps.mcpServer) {
        try {
          deps.mcpServer.decideApproval(realId, body.decision);
        } catch {
          // The approval wasn't an MCP-server one (or was already consumed);
          // the gateway decision above is authoritative.
        }
      }
      res.json(decided);
    } catch (err) {
      res.status(500).json(errorBody('Failed to decide approval', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Audit --------------------------------------------------------------
  router.get('/audit', (req, res) => {
    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 100;
    try {
      res.json(governance.listAudit(limit));
    } catch (err) {
      res.status(500).json(errorBody('Failed to list audit entries', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Models -------------------------------------------------------------
  // Flat model catalog with free flags and (estimated) per-1M prices.
  // ?freeOnly=1 filters to free models (powers the web UI "Free only" toggle).
  // Prices are public-list-price estimates, not live billing — see pricing.ts.
  router.get('/models', (_req, res) => {
    try {
      const freeOnly = _req.query.freeOnly === '1' || _req.query.freeOnly === 'true';
      const models: Array<{
        providerId: string;
        id: string;
        name: string;
        contextLength?: number;
        free: boolean;
        inputPer1M?: number;
        outputPer1M?: number;
        estimated: boolean;
      }> = [];
      for (const preset of listProviderPresets()) {
        for (const m of preset.models) {
          const free = isFreeModel(preset.id, m.id);
          if (freeOnly && !free) continue;
          const price = priceOfModel(preset.id, m.id);
          models.push({
            providerId: preset.id,
            id: m.id,
            name: m.name,
            contextLength: m.contextLength,
            free,
            inputPer1M: price?.inputPer1M,
            outputPer1M: price?.outputPer1M,
            estimated: price ? price.estimate : true,
          });
        }
      }
      res.json(models);
    } catch (err) {
      res.status(500).json(errorBody('Failed to list models', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Providers ----------------------------------------------------------
  router.get('/providers', async (_req, res) => {
    try {
      res.json(await listProviders(config.dataDir));
    } catch (err) {
      res.status(500).json(errorBody('Failed to list providers', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/providers/keys', (req, res) => {
    const body = (req.body ?? {}) as Partial<ProviderKeyBody>;
    if (typeof body.providerId !== 'string' || !body.providerId) {
      res.status(400).json(errorBody('providerId is required'));
      return;
    }
    if (typeof body.apiKey !== 'string' || !body.apiKey) {
      res.status(400).json(errorBody('apiKey is required'));
      return;
    }
    if (body.headers !== undefined && (typeof body.headers !== 'object' || body.headers === null)) {
      res.status(400).json(errorBody('headers must be an object'));
      return;
    }
    try {
      if (!isKnownProviderId(body.providerId)) {
        res.status(400).json(
          errorBody(`Unknown provider "${body.providerId}". Use a catalog provider or a "custom-*" id.`),
        );
        return;
      }
      // Never log the key: only the provider id is safe to mention.
      saveProviderKey(config.dataDir, body.providerId, {
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        headers: body.headers,
      });
      console.log(`[providers] stored key for provider "${body.providerId}"`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json(errorBody('Failed to store provider key', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/providers/keys/:providerId', (req, res) => {
    try {
      const removed = removeProviderKey(config.dataDir, req.params.providerId);
      if (!removed) {
        if (isConfiguredSafe(req.params.providerId)) {
          res.status(400).json(errorBody(`Provider "${req.params.providerId}" is configured via environment, not the local file`));
          return;
        }
        res.status(404).json(errorBody(`No stored key for provider "${req.params.providerId}"`));
        return;
      }
      console.log(`[providers] removed key for provider "${req.params.providerId}"`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody('Failed to remove provider key', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Subscription/CLI bridges (MausBot parity) ---------------------------
  // Consent-gated reuse of the user's own Claude Code / Codex CLI logins.
  // No credential bytes are stored: consent lives in memory only.
  router.post('/providers/bridges/:bridgeId/connect', (req, res) => {
    try {
      connectBridge(req.params.bridgeId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json(errorBody('Failed to connect bridge', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/providers/bridges/:bridgeId/disconnect', (req, res) => {
    try {
      const was = disconnectBridge(req.params.bridgeId);
      if (!was) {
        res.status(404).json(errorBody(`Bridge "${req.params.bridgeId}" is not connected`));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(errorBody('Failed to disconnect bridge', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Workflows ----------------------------------------------------------
  router.get('/workflows', (_req, res) => {
    try {
      res.json(workflowRunner.listWorkflows());
    } catch (err) {
      res.status(500).json(errorBody('Failed to list workflows', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/workflows/:id/run', async (req, res) => {
    const body = (req.body ?? {}) as Partial<RunWorkflowBody>;
    try {
      try {
        workflowRunner.getWorkflow(req.params.id);
      } catch {
        res.status(404).json(errorBody(`Unknown workflow "${req.params.id}"`));
        return;
      }
      // The runner dedupes idempotency keys internally.
      const run = await workflowRunner.startRun(req.params.id, body.input, {
        idempotencyKey: body.idempotencyKey,
      });
      deps.governance.audit('workflow.run_requested', {
        actor: 'api',
        sessionId: run.id,
        detail: { workflowId: req.params.id, idempotencyKey: body.idempotencyKey ?? null },
      });
      res.json({ runId: run.id });
    } catch (err) {
      res.status(500).json(errorBody('Failed to start workflow run', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/workflows/runs', (_req, res) => {
    try {
      const runs = workflowRunner.listRuns();
      const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);
      res.json(sorted);
    } catch (err) {
      res.status(500).json(errorBody('Failed to list workflow runs', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/workflows/runs/:runId', (req, res) => {
    try {
      const run = workflowRunner.getRun(req.params.runId);
      if (!run) {
        res.status(404).json(errorBody(`Unknown run "${req.params.runId}"`));
        return;
      }
      res.json(run);
    } catch (err) {
      res.status(500).json(errorBody('Failed to get workflow run', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/workflows/runs/:runId/stream', (req, res) => {
    try {
      const runId = req.params.runId;
      const initial = workflowRunner.getRun(runId);
      if (!initial) {
        res.status(404).json(errorBody(`Unknown run "${runId}"`));
        return;
      }
      sseHeaders(res);
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, 15000);
      const finish = () => {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          res.end();
        }
      };
      const send = (run: WorkflowRun) => {
        if (!closed) res.write(`data: ${JSON.stringify(run)}\n\n`);
      };
      // onRunUpdate is global — filter to this run.
      const unsubscribe = workflowRunner.onRunUpdate((run) => {
        if (run.id !== runId || closed) return;
        send(run);
        if (TERMINAL_RUN_STATUSES.has(run.status)) finish();
      });
      res.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      });
      send(initial);
      if (TERMINAL_RUN_STATUSES.has(initial.status)) finish();
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json(errorBody('Failed to stream workflow run', err instanceof Error ? err.message : String(err)));
      }
    }
  });

  // ---- Dry run ------------------------------------------------------------
  router.post('/dry-run', async (req, res) => {
    const body = (req.body ?? {}) as Partial<DryRunBody>;
    if (typeof body.botId !== 'string' || !body.botId) {
      res.status(400).json(errorBody('botId is required'));
      return;
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json(errorBody('message is required'));
      return;
    }
    const bot = bots.find((b) => b.id === body.botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${body.botId}"`));
      return;
    }
    try {
      const report = await agentRuntime.previewTurn(bot, body.message);
      res.json(report);
    } catch (err) {
      res.status(500).json(errorBody('Dry run failed', err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- Phase 3: connected apps (OAuth) + messaging gateway ---------------
  // Both modules register relative paths on the main router, so they land
  // under /api/oauth/... and /api/messaging/....
  registerOAuthRoutes(router, { config, governance });
  registerMessagingRoutes(router, { config, governance });

  // ---- Phase 3: user notes + tasks/calendar ------------------------------
  // Notes live on a sub-router mounted at /api/notes; tasks registers
  // /api/tasks and /api/events on the main router itself.
  const notesRouter = express.Router();
  registerNotesRoutes(notesRouter, { dataDir: config.dataDir });
  router.use('/notes', notesRouter);
  registerTasksRoutes(router, { dataDir: config.dataDir });

  return router;
}

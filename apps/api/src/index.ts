// SPDX-License-Identifier: Apache-2.0
// API entry point. Boot sequence:
//   1. load config (port/paths) and seed data (bots, workflows, MCP servers)
//   2. construct the real GovernanceGateway, wrap it in a GovernanceAdapter
//      for the agent runtime, and build the tool registry (built-ins + MCP)
//   3. construct AgentRuntime and WorkflowRunner, register workflows
//   4. mount /api routes, then the static frontend (single-binary serving)
//   5. listen
//
// Run: `bun --watch src/index.ts` (dev) / `bun src/index.ts` (prod).
// The Tauri sidecar spawns this with `--port 4567` and DATA_DIR set to the
// desktop app-data dir.

import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime } from '@mvp/agent-runtime';
import type { BotConfig } from '@mvp/agent-runtime';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { Scheduler, TriggerStore, WorkflowRunner } from '@mvp/workflows';
import { loadConfig } from './config.js';
import { GovernanceAdapter } from './governance-adapter.js';
import { SEED_FILES } from './generated/seed.js';
import { loadSeed } from './seed.js';
import { syncProviderKeysToEnv } from './providers.js';
import { applyBotPolicies } from './bot-policies.js';
import { buildToolRegistry } from './tool-registry.js';
import { registerDelegateTools } from './delegate-wiring.js';
import { createSummarizer } from './summarizer.js';
import { createRouter } from './routes.js';
import { createWebhookRouter } from './webhooks.js';
import { mountWebAssets } from './web-assets.js';
import { runChatCli } from './cli.js';

// Pipe/JSON chat mode: `mvp-server chat --bot <id> [--json]`. Parsed at the
// very top, before boot(), so `chat` never starts the HTTP server.
// runChatCli returns the exit code; index.ts owns process.exit.
if (process.argv[2] === 'chat') {
  const code = await runChatCli(process.argv.slice(2));
  process.exit(code);
}

/**
 * Resolve the seed directory. Single-file binaries (bun --compile) ship with
 * embedded seed data: when SEED_DIR does not exist on disk, the embedded
 * files are extracted to a temp dir so bots/skills/workflows still load.
 */
function resolveSeedDir(configured: string): string {
  if (fs.existsSync(configured)) return configured;
  const entries = Object.entries(SEED_FILES);
  if (entries.length === 0) return configured; // let loadSeed() warn
  const dir = path.join(os.tmpdir(), 'mvp-seed-embedded');
  for (const [rel, content] of entries) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, content, 'utf8');
  }
  console.log(`[seed] SEED_DIR not found — extracted ${entries.length} embedded seed file(s) to ${dir}`);
  return dir;
}

async function boot(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });

  // The agent-runtime resolves provider keys via env vars first. It cannot
  // read the encrypted providers.local.json envelope itself (only the
  // providers module holds the machine key), so mirror the decrypted file
  // into process.env here at boot — and after every save/remove via the
  // Providers API. Fail-closed: a tampered/unreadable key file aborts boot
  // loudly instead of running keyless.
  if (!process.env.PROVIDERS_FILE) {
    process.env.PROVIDERS_FILE = path.join(config.dataDir, 'providers.local.json');
  }
  syncProviderKeysToEnv(config.dataDir);

  const seedDir = resolveSeedDir(config.seedDir);
  const seed = loadSeed(seedDir);

  // Phase 2: per-bot policy overrides persisted in <dataDir>/bot-policies.json
  // are applied onto the in-memory bot configs before anything else reads them.
  applyBotPolicies(seed.bots, config.dataDir);
  const botsById = new Map<string, BotConfig>(seed.bots.map((b) => [b.id, b]));

  // 2. Governance + tools.
  const governance = new GovernanceGateway({
    dbPath: `${config.dataDir}/governance.db`,
    policy: DEFAULT_POLICY,
  });
  // The runtime expects its own governance surface (agent-runtime documents
  // it as a local interface); the adapter bridges it to the real gateway.
  // Tool executions are audited by the runtime itself through this adapter
  // (tool.denied / tool.approval_requested / tool.approval_decided /
  // tool.executed), so no extra hooks are registered here — they would
  // double-log. Phase 2: getBotConfig lets the adapter evaluate per-bot
  // policy overrides (bot rules prepended, first match wins).
  const governanceAdapter = new GovernanceAdapter(governance, {
    getBotConfig: (id) => botsById.get(id),
  });

  const { registry: toolRegistry, connections: mcpConnections, close: closeMcp } =
    await buildToolRegistry({
      workspaceDir: config.workspaceDir,
      dataDir: config.dataDir,
      skillsDir: path.join(seedDir, 'skills'),
      mcpServers: seed.mcpServers,
      // GovernanceGateway satisfies SchemaDriftApprovalBroker structurally:
      // MCP schema drift at (re)connect raises a human approval here.
      approvalBroker: governance,
    });

  // 3. Agent runtime + workflows.
  const agentRuntime = new AgentRuntime({
    dbPath: `${config.dataDir}/agent.db`,
    skillsDir: path.join(seedDir, 'skills'),
    governance: governanceAdapter,
    toolRegistry,
    // Phase 2: summarization auto-compaction replaces blind truncation once
    // sessions grow past the threshold; the last-100-messages floor stays.
    sessionStoreOptions: { summarizer: createSummarizer() },
  });

  // Phase 2: `delegate` subagent tool. The child runs under the same
  // governance policy; parent/child records + audit events land in
  // subagents.db and the audit log (visible in Audit/Activity).
  registerDelegateTools({
    registry: toolRegistry,
    dataDir: config.dataDir,
    skillsDir: path.join(seedDir, 'skills'),
    governanceAdapter,
    getBotConfig: (id) => botsById.get(id),
    audit: (action, fields) => governance.audit(action, fields),
  });

  const workflowRunner = new WorkflowRunner({
    dbPath: `${config.dataDir}/workflows.db`,
    agentRuntime,
    governance,
    tools: toolRegistry,
    bots: botsById,
  });
  for (const def of seed.workflows) {
    try {
      workflowRunner.register(def);
    } catch (err) {
      console.warn(
        `[seed] workflow "${def.id}" failed validation, skipping: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Audit workflow lifecycle (paused for approval, terminal states) so the
  // audit trail covers workflow runs end to end.
  const auditedRuns = new Set<string>();
  workflowRunner.onRunUpdate((run) => {
    if (run.status === 'paused' && !auditedRuns.has(`${run.id}:paused`)) {
      auditedRuns.add(`${run.id}:paused`);
      governance.audit('workflow.paused', {
        actor: 'system',
        sessionId: run.id,
        detail: { workflowId: run.workflowId },
      });
    }
    if ((run.status === 'succeeded' || run.status === 'failed') && !auditedRuns.has(run.id)) {
      auditedRuns.add(run.id);
      governance.audit(`workflow.${run.status}`, {
        actor: 'system',
        sessionId: run.id,
        detail: { workflowId: run.workflowId },
      });
    }
  });

  // Phase 2: crash-resume — incomplete runs from a previous (crashed)
  // process resume from their last checkpoint before anything new fires.
  // Then start the trigger scheduler (cron) and mount webhook triggers.
  const recovered = await workflowRunner.recover();
  if (recovered.length > 0) {
    console.log(`[workflows] recovered ${recovered.length} interrupted run(s): ${recovered.join(', ')}`);
  }
  const triggerStore = new TriggerStore(path.join(config.dataDir, 'triggers.db'));
  const scheduler = new Scheduler();
  scheduler.start(workflowRunner, triggerStore);

  // 4. HTTP layer. API routes first, then the frontend.
  const app = express();
  // MVP: allow any origin — the Tauri webview calls the sidecar API
  // cross-origin (http://127.0.0.1:4567). Revisit with an allowlist when
  // auth/multi-user ships.
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '1mb' }));
  // Phase 2: workflow webhook triggers (shared-secret authenticated).
  app.use('/webhooks', createWebhookRouter({ runner: workflowRunner, triggerStore }));
  app.use(
    '/api',
    createRouter({
      config,
      bots: seed.bots,
      agentRuntime,
      governance,
      governanceAdapter,
      workflowRunner,
      mcpConnections,
    }),
  );
  // Unknown /api paths → JSON 404 (before the SPA fallback claims them).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown API route' });
  });
  mountWebAssets(app, config.webOutDir);

  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(`[api] listening on http://127.0.0.1:${config.port}`);
    console.log(
      `[api] data dir: ${config.dataDir} | bots: ${seed.bots.length} | ` +
        `workflows: ${seed.workflows.length} | tools: ${toolRegistry.size} | ` +
        `mcp: ${mcpConnections.filter((c) => c.ok).length}/${mcpConnections.length} connected`,
    );
  });

  const shutdown = async () => {
    console.log('[api] shutting down…');
    server.close();
    scheduler.stop();
    await closeMcp();
    try {
      agentRuntime.close();
    } catch {
      // ignore
    }
    try {
      workflowRunner.close();
    } catch {
      // ignore
    }
    try {
      governance.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

boot().catch((err) => {
  console.error('[api] fatal boot error:', err);
  process.exit(1);
});

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
import { WorkflowRunner } from '@mvp/workflows';
import { loadConfig } from './config.js';
import { GovernanceAdapter } from './governance-adapter.js';
import { SEED_FILES } from './generated/seed.js';
import { loadSeed } from './seed.js';
import { syncProviderKeysToEnv } from './providers.js';
import { buildToolRegistry } from './tool-registry.js';
import { createRouter } from './routes.js';
import { mountWebAssets } from './web-assets.js';

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
  // double-log.
  const governanceAdapter = new GovernanceAdapter(governance);

  const { registry: toolRegistry, connections: mcpConnections, close: closeMcp } =
    await buildToolRegistry({
      workspaceDir: config.workspaceDir,
      dataDir: config.dataDir,
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
  });

  const botsById = new Map<string, BotConfig>(seed.bots.map((b) => [b.id, b]));
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

  // 4. HTTP layer. API routes first, then the frontend.
  const app = express();
  // MVP: allow any origin — the Tauri webview calls the sidecar API
  // cross-origin (http://127.0.0.1:4567). Revisit with an allowlist when
  // auth/multi-user ships.
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '1mb' }));
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

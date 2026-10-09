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
import type { WorkflowRun } from '@mvp/workflows';
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
// Phase 3: scheduled workflows create tasks; the platform also serves its
// own tools as an MCP server (two-way MCP).
import { makeTaskCreator } from './tasks.js';
import { PlatformMcpServer, toolProviderFromRegistry } from '@mvp/agent-runtime';
// Phase 4: computer-use + muse-module agent tools, policy rules, protocols,
// and the reminders module (scheduler routing). The computer.ts subpath is
// imported directly (not re-exported from the agent-runtime index — index
// untouched), following the pricing.ts precedent in routes.ts.
import { computerUsePolicyRules, registerComputerUseTool } from '@mvp/agent-runtime/dist/tools/computer.js';
// Real foreground OS layer (opt-in via COMPUTER_USE_REAL=1; mock by default).
// Same direct-dist-subpath import pattern as computer.js above.
import { selectOSLayer } from '@mvp/agent-runtime/dist/tools/computer-real.js';
import {
  ModuleDb,
  ReminderStore,
  fireReminder,
  registerMuseModuleTools,
  museModuleToolPolicies,
} from '@mvp/muse-modules';
import { defaultAgentCard } from '@mvp/protocols';
import type { Policy } from '@mvp/governance';

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

/**
 * Phase 3: build the platform's own MCP server (two-way MCP) over the real
 * tool registry. External clients (Claude Code, etc.) can list/call our
 * tools and chat with a bot; the governance approval policy still applies —
 * require-approval tools never execute silently (see mcp-server.ts).
 */
function buildPlatformMcpServer(opts: {
  toolRegistry: Map<string, import('@mvp/agent-runtime').ToolDefinition>;
  /** The GovernanceAdapter (runtime governance surface), not the raw gateway. */
  governance: import('@mvp/agent-runtime').GovernanceGateway;
  agentRuntime: AgentRuntime;
  bots: BotConfig[];
}): PlatformMcpServer {
  const fallbackBot = opts.bots[0];
  return new PlatformMcpServer({
    tools: toolProviderFromRegistry(opts.toolRegistry),
    governance: opts.governance,
    botId: 'mcp-gateway',
    chat: fallbackBot
      ? {
          description: `Chat with the "${fallbackBot.id}" bot (one turn).`,
          handler: async (message: string) => {
            let content = '';
            await opts.agentRuntime.runTurn({
              bot: fallbackBot,
              message: String(message),
              taskType: 'chat',
              onEvent: (e) => {
                if (e.type === 'token' && typeof e.content === 'string') content += e.content;
              },
            });
            return content;
          },
        }
      : undefined,
  });
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
  // MBTI personas: per-bot overlay from <dataDir>/bot-personas.json.
  const { applyBotPersonas } = await import('./bot-personas.js');
  applyBotPersonas(seed.bots, config.dataDir);
  // Per-bot workspaces (Octop-style isolation): overlay from
  // <dataDir>/bot-workspaces.json. Unset → global workspaceDir.
  const { applyBotWorkspaces } = await import('./bot-workspaces.js');
  applyBotWorkspaces(seed.bots, config.dataDir);
  const botsById = new Map<string, BotConfig>(seed.bots.map((b) => [b.id, b]));

  // 2. Governance + tools.
  // Phase 4: prepend approval-gating rules for the new agent tools
  // (computer use, browser automation). First match wins; these are
  // require-approval — strictly stronger than the defaults they precede,
  // so deny-by-default is preserved and extended.
  const globalPolicy: Policy = {
    ...DEFAULT_POLICY,
    rules: [...computerUsePolicyRules(), ...museModuleToolPolicies(), ...DEFAULT_POLICY.rules],
  };
  const governance = new GovernanceGateway({
    dbPath: `${config.dataDir}/governance.db`,
    policy: globalPolicy,
  });
  // The runtime expects its own governance surface (agent-runtime documents
  // it as a local interface); the adapter bridges it to the real gateway.
  // Tool executions are audited by the runtime itself through this adapter
  // (tool.denied / tool.approval_requested / tool.approval_decided /
  // tool.executed), so no extra hooks are registered here — they would
  // double-log. Phase 2: getBotConfig lets the adapter evaluate per-bot
  // policy overrides (bot rules prepended, first match wins).
  const { PreferenceStore } = await import('./preferences.js');
  const preferenceStore = new PreferenceStore(config.dataDir);

  const governanceAdapter = new GovernanceAdapter(governance, {
    getBotConfig: (id) => botsById.get(id),
    globalPolicy,
    getPreference: (botId, toolName) => preferenceStore.getPreference(botId, toolName)?.preference,
  });

  const { registry: toolRegistry, connections: mcpConnections, connectMcp, close: closeMcp } =
    await buildToolRegistry({
      workspaceDir: config.workspaceDir,
      dataDir: config.dataDir,
      skillsDir: path.join(seedDir, 'skills'),
      mcpServers: seed.mcpServers,
      // GovernanceGateway satisfies SchemaDriftApprovalBroker structurally:
      // MCP schema drift at (re)connect raises a human approval here.
      approvalBroker: governance,
      // Per-bot workspaces: file/shell/git tools resolve the calling bot's
      // workspace per tool-call (Octop-style isolation).
      getBotConfig: (id) => botsById.get(id),
    });

  // Phase 4: computer-use tools (sandboxed GUI automation; mutating actions
  // are approval-gated via computerUsePolicyRules above; the default OS
  // layer is the mock — no real input) and Muse-module tools (research_deep,
  // browser_action — browser_action approval-gated via museModuleToolPolicies).
  // selectOSLayer() returns the REAL foreground layer only when
  // COMPUTER_USE_REAL=1; otherwise the safe mock. The approval gate applies
  // identically either way — governance evaluates before the handler runs.
  registerComputerUseTool(toolRegistry, {
    os: selectOSLayer({
      onRealAction: (action, detail) => {
        console.log(`[computer-real] ${action}`, JSON.stringify(detail));
        try {
          governance.audit('tool.computer_real_action', {
            actor: 'agent',
            toolName: `computer_${action}`,
            detail,
          });
        } catch {
          // Audit must never break input.
        }
      },
    }),
  });
  registerMuseModuleTools(toolRegistry, { dataDir: config.dataDir });

  // 3. Agent runtime + workflows.
  const { CheckpointStore } = await import('./checkpoints.js');
  const checkpointStore = new CheckpointStore(config.dataDir);

  const { DotStore } = await import('./dots.js');
  const dotStore = new DotStore(config.dataDir);

  const { RecordingStore } = await import('./recordings.js');
  const recordingStore = new RecordingStore(config.dataDir);

  const { ChatQueueStore } = await import('./chat-queue.js');
  const chatQueueStore = new ChatQueueStore(config.dataDir);
  // Reset any 'started' rows left by a crashed turn back to queued for retry.
  chatQueueStore.resetStarted();

  const agentRuntime = new AgentRuntime({
    dbPath: `${config.dataDir}/agent.db`,
    skillsDir: path.join(seedDir, 'skills'),
    governance: governanceAdapter,
    toolRegistry,
    // Phase 2: summarization auto-compaction replaces blind truncation once
    // sessions grow past the threshold; the last-100-messages floor stays.
    sessionStoreOptions: { summarizer: createSummarizer() },
    // Checkpoints: snapshot files before mutation (Claude Code rewind).
    // One checkpoint per (session, tool call) — files accumulate per call.
    onBeforeFileMutate: async (info) => {
      checkpointStore.create({
        sessionId: info.sessionId,
        files: { [info.path]: info.contentBefore },
        historyLength: info.historyLength,
        label: `before ${info.toolName} ${info.path}`,
      });
    },
  });

  // Phase 2: `delegate` subagent tool. The child runs under the same
  // governance policy; parent/child records + audit events land in
  // subagents.db and the audit log (visible in Audit/Activity).
  registerDelegateTools({
    registry: toolRegistry,
    dataDir: config.dataDir,
    skillsDir: path.join(seedDir, 'skills'),
    workspaceDir: config.workspaceDir,
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

  // Phase 3: two-way MCP over stdio — serve the platform's tools to an
  // external MCP client on stdin/stdout instead of starting HTTP.
  // Usage: mvp-server --mcp-stdio
  if (process.argv.includes('--mcp-stdio')) {
    const mcpServer = buildPlatformMcpServer({
      toolRegistry,
      governance: governanceAdapter,
      agentRuntime,
      bots: seed.bots,
    });
    await mcpServer.serveStdio();
    return;
  }

  // Phase 2: crash-resume — incomplete runs from a previous (crashed)
  // process resume from their last checkpoint before anything new fires.
  // Then start the trigger scheduler (cron) and mount webhook triggers.
  const recovered = await workflowRunner.recover();
  if (recovered.length > 0) {
    console.log(`[workflows] recovered ${recovered.length} interrupted run(s): ${recovered.join(', ')}`);
  }
  const triggerStore = new TriggerStore(path.join(config.dataDir, 'triggers.db'));
  const scheduler = new Scheduler();
  // Phase 4: route muse-reminder:* triggers to the reminders module instead
  // of the workflow runner (their workflowId is a reminder id, not a
  // registered workflow). fireReminder is idempotent; the onFire callback
  // below still records a task so the reminder is visible in Activity.
  const reminderStore = new ReminderStore(new ModuleDb(path.join(config.dataDir, 'muse-modules.db')));
  const schedulerRunner = {
    getRunByIdempotencyKey: (key: string) => workflowRunner.getRunByIdempotencyKey(key),
    startRun: async (
      workflowId: string,
      input: unknown,
      opts?: { idempotencyKey?: string },
    ): Promise<WorkflowRun> => {
      if (workflowId.startsWith('muse-reminder:')) {
        const reminderId = workflowId.slice('muse-reminder:'.length);
        fireReminder(reminderStore, reminderId);
        return { id: `reminder:${reminderId}:${Date.now()}` } as WorkflowRun;
      }
      return workflowRunner.startRun(workflowId, input, opts);
    },
  } as unknown as WorkflowRunner;
  // Phase 3: every scheduled workflow run leaves a task so the user can see
  // what ran and when (wired via the tasks module; failures never break the
  // scheduler tick).
  const createTask = makeTaskCreator({ dataDir: config.dataDir });
  scheduler.start(schedulerRunner, triggerStore, (trigger, runId) => {
    try {
      createTask({
        title: `Scheduled workflow ran: ${trigger.workflowId}`,
        notes: `Trigger ${trigger.id} (${trigger.kind}) fired — run ${runId}.`,
        dueAt: null,
      });
    } catch (err) {
      console.error(
        `[tasks] failed to record scheduled run ${runId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  });

  // Thread automations: wake chat threads on a schedule (Codex-style).
  // Each wake leaves a task so the user can see what the agent did.
  const { ThreadScheduleStore, ThreadScheduler } = await import('./thread-scheduler.js');
  const threadScheduleStore = new ThreadScheduleStore(config.dataDir);
  const threadScheduler = new ThreadScheduler({
    store: threadScheduleStore,
    agentRuntime,
    getBots: () => seed.bots,
    getPersistentSandboxId: (sessionId) => dotStore.getBySessionId(sessionId)?.environmentId,
    onWake: ({ schedule, ok, error }) => {
      try {
        createTask({
          title: ok
            ? `Thread woke on schedule: ${schedule.sessionId}`
            : `Thread wake failed: ${schedule.sessionId}`,
          notes: ok
            ? `Schedule ${schedule.id} fired — agent checked in on session ${schedule.sessionId}.`
            : `Schedule ${schedule.id} failed: ${error ?? 'unknown error'}`,
          dueAt: null,
        });
      } catch (err) {
        console.error('[tasks] failed to record thread wake:', err instanceof Error ? err.message : err);
      }
    },
  });
  threadScheduler.start();

  // Phase 3: two-way MCP over HTTP+SSE on a separate port when configured.
  // External clients connect to http://127.0.0.1:<port>/sse.
  let mcpServer: PlatformMcpServer | undefined;
  const mcpPort = Number(process.env.MCP_SERVER_PORT ?? 0);
  if (Number.isFinite(mcpPort) && mcpPort > 0) {
    mcpServer = buildPlatformMcpServer({
      toolRegistry,
      governance: governanceAdapter,
      agentRuntime,
      bots: seed.bots,
    });
    const { url } = await mcpServer.serveHttp({ port: mcpPort });
    console.log(`[mcp] platform MCP server on ${url}`);
  }

  // 4. HTTP layer. API routes first, then the frontend.
  const app = express();
  // MVP: allow any origin — the Tauri webview calls the sidecar API
  // cross-origin (http://127.0.0.1:4567). Revisit with an allowlist when
  // auth/multi-user ships.
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '1mb' }));
  // Phase 4: A2A agent-card discovery (spec-correct location).
  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.json(defaultAgentCard(`http://127.0.0.1:${config.port}/api/protocols/a2a`));
  });
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
      mcpServer,
      threadScheduleStore,
      checkpointStore,
      dotStore,
      preferenceStore,
      recordingStore,
      chatQueueStore,
      mcpServers: seed.mcpServers,
      tieredMemoryStore: new (await import('@mvp/agent-runtime')).TieredMemoryStore(config.dataDir),
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
        `mcp: warming up in background`,
    );
    // MCP servers connect AFTER listen so a slow/failing server never
    // delays boot. The shared mcpConnections array fills in as they land.
    void connectMcp()
      .catch((err) => console.error('[tools] MCP warmup crashed:', err))
      .finally(() => {
        console.log(
          `[tools] MCP warmup done: ${mcpConnections.filter((c) => c.ok).length}/${mcpConnections.length} connected`,
        );
      });
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

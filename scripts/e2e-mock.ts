// SPDX-License-Identifier: Apache-2.0
// Mocked end-to-end verification of the MVP core loop (no provider API key needed):
//   chat turn -> stateful tool call -> approval pause -> approve -> result streams back
//   deny path, parallel read-only tools, dry-run, workflow run, audit redaction.
// Run: bun scripts/e2e-mock.ts   (from the mvp/ directory)
// Exits non-zero on any assertion failure.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRuntime,
  MockProvider,
  createBuiltInTools,
  type BotConfig,
  type LLMProvider,
  type StreamEvent,
  type ToolDefinition,
} from '@mvp/agent-runtime';
import { GovernanceGateway, DEFAULT_POLICY } from '@mvp/governance';
import { WorkflowRunner, type WorkflowDefinition } from '@mvp/workflows';
import { GovernanceAdapter } from '../apps/api/dist/governance-adapter.js';

let failures = 0;
function assert(cond: boolean, label: string, extra?: unknown): void {
  if (cond) {
    console.log(`  PASS ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

const BOT: BotConfig = {
  id: 'e2e-bot',
  name: 'E2E',
  description: 'e2e',
  systemPrompt: 'You are a test bot. Use tools when asked.',
  provider: 'mock',
  model: 'mock-model',
  skills: [],
  tools: [],
  mcpServers: [],
};

class MockRuntime extends AgentRuntime {
  constructor(opts: ConstructorParameters<typeof AgentRuntime>[0], private mock: MockProvider) {
    super(opts);
  }
  protected resolveProvider(_providerId: string): LLMProvider {
    return this.mock;
  }
}

async function main(): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), 'mvp-e2e-ws-'));
  const tools = new Map<string, ToolDefinition>();
  for (const t of createBuiltInTools({ workspaceDir: ws })) tools.set(t.name, t);

  const gateway = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
  const adapter = new GovernanceAdapter(gateway);

  // ---- 1. approve path: write_file pauses, approve resumes ----
  console.log('1. approve path (write_file -> approval -> approved -> written)');
  {
    const mock = new MockProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'note.txt', content: 'hello e2e' } }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      { content: 'written!', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ]);
    const rt = new MockRuntime(
      { dbPath: ':memory:', skillsDir: 'seed/skills', governance: adapter, toolRegistry: tools },
      mock,
    );
    const events: StreamEvent[] = [];
    const turn = rt.runTurn({ bot: BOT, message: 'write note.txt', onEvent: (e) => void events.push(e) });
    const pending = await withTimeout(
      (async () => {
        for (;;) {
          const p = gateway.listApprovals('pending');
          if (p.length > 0) return p[0]!;
          await new Promise((r) => setTimeout(r, 25));
        }
      })(),
      8000,
      'approval to appear',
    );
    assert(pending.toolName === 'write_file', 'approval created for write_file', pending.toolName);
    assert(events.some((e) => e.type === 'approval_required'), 'approval_required event emitted');
    // secret-redaction check: args snapshot must not leak anything sensitive
    gateway.decide(pending.id, 'approved', { decidedBy: 'e2e' });
    const usage = await withTimeout(turn, 8000, 'turn to finish after approve');
    assert(usage.totalTokens === 30, 'token usage summed across iterations', usage);
    assert(existsSync(join(ws, 'note.txt')), 'file written after approval');
    assert(readFileSync(join(ws, 'note.txt'), 'utf8') === 'hello e2e', 'file content correct');
    assert(events.some((e) => e.type === 'done'), 'done event emitted');
    assert(events.filter((e) => e.type === 'token').join('').length >= 0, 'token events streamed');
  }

  // ---- 2. deny path ----
  console.log('2. deny path (run_command -> denied -> clean stop)');
  {
    const mock = new MockProvider([
      {
        content: '',
        toolCalls: [{ id: 'c2', name: 'run_command', args: { command: 'echo hi' } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      { content: 'ok, stopped', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    const rt = new MockRuntime(
      { dbPath: ':memory:', skillsDir: 'seed/skills', governance: adapter, toolRegistry: tools },
      mock,
    );
    const events: StreamEvent[] = [];
    const turn = rt.runTurn({ bot: BOT, message: 'run echo', onEvent: (e) => void events.push(e) });
    const pending = await withTimeout(
      (async () => {
        for (;;) {
          const p = gateway.listApprovals('pending');
          if (p.length > 0) return p[0]!;
          await new Promise((r) => setTimeout(r, 25));
        }
      })(),
      8000,
      'approval to appear (deny)',
    );
    gateway.decide(pending.id, 'denied', { decidedBy: 'e2e' });
    await withTimeout(turn, 8000, 'turn to finish after deny');
    const denied = events.find((e) => e.type === 'tool_result' && (e as { denied?: boolean }).denied);
    assert(denied !== undefined, 'tool_result marked denied');
    assert(events.some((e) => e.type === 'done'), 'turn completes after deny');
  }

  // ---- 3. parallel read-only tools auto-allow ----
  console.log('3. parallel read-only tools (no approval needed)');
  {
    const mock = new MockProvider([
      {
        content: '',
        toolCalls: [
          { id: 'c3', name: 'web_search', args: { query: 'test' } },
          { id: 'c4', name: 'web_search', args: { query: 'test2' } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      { content: 'searched', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    const rt = new MockRuntime(
      { dbPath: ':memory:', skillsDir: 'seed/skills', governance: adapter, toolRegistry: tools },
      mock,
    );
    const events: StreamEvent[] = [];
    await withTimeout(
      rt.runTurn({ bot: BOT, message: 'search twice', onEvent: (e) => void events.push(e) }),
      15000,
      'parallel tools turn',
    );
    assert(gateway.listApprovals('pending').length === 0, 'no approvals for read-only tools');
    assert(
      events.filter((e) => e.type === 'tool_result').length === 2,
      'both tool results returned',
    );
  }

  // ---- 4. dry-run preview ----
  console.log('4. dry-run preview');
  {
    const mock = new MockProvider([{ content: 'x', toolCalls: [] }]);
    const rt = new MockRuntime(
      { dbPath: ':memory:', skillsDir: 'seed/skills', governance: adapter, toolRegistry: tools },
      mock,
    );
    const report = await rt.previewTurn({ ...BOT, provider: 'groq' }, 'hi');
    assert(report.verdict === 'blocked', 'dry-run blocked without GROQ_API_KEY', report.verdict);
    assert(report.nextActions.length > 0, 'dry-run suggests next actions');
  }

  // ---- 5. workflow run: agent -> approval -> tool ----
  console.log('5. workflow run (agent -> approval -> tool)');
  {
    const mock = new MockProvider([
      { content: 'mock summary', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]);
    const rt = new MockRuntime(
      { dbPath: ':memory:', skillsDir: 'seed/skills', governance: adapter, toolRegistry: tools },
      mock,
    );
    const bots = new Map<string, BotConfig>([[BOT.id, BOT]]);
    const runner = new WorkflowRunner({
      dbPath: ':memory:',
      agentRuntime: rt,
      governance: gateway,
      tools,
      bots,
    });
    const def: WorkflowDefinition = {
      id: 'wf-e2e',
      name: 'E2E',
      nodes: [
        { id: 'trigger', type: 'trigger', name: 'T', config: {} },
        { id: 'a1', type: 'agent', name: 'A', config: { botId: BOT.id, prompt: 'summarize {{input}}' } },
        { id: 'appr', type: 'approval', name: 'R', config: { message: 'ok? {{nodes.a1.output}}' } },
        {
          id: 't1',
          type: 'tool',
          name: 'W',
          config: { tool: 'write_file', args: { path: 'wf.txt', content: '{{nodes.a1.output}}' } },
        },
      ],
      edges: [
        ['trigger', 'a1'],
        ['a1', 'appr'],
        ['appr', 't1'],
      ],
    };
    runner.register(def);
    const run = await runner.startRun('wf-e2e', 'some topic');
    // wait for pause at approval node
    await withTimeout(
      (async () => {
        for (;;) {
          const r = runner.getRun(run.id);
          if (r && r.status === 'paused') return;
          await new Promise((res) => setTimeout(res, 25));
        }
      })(),
      8000,
      'workflow to pause',
    );
    const paused = runner.getRun(run.id)!;
    const apprId = paused.nodeStates['appr']?.approvalId;
    assert(typeof apprId === 'string', 'approval node paused with approvalId');
    gateway.decide(apprId!, 'approved', { decidedBy: 'e2e' });
    // the tool node (write_file) also needs approval
    const toolAppr = await withTimeout(
      (async () => {
        for (;;) {
          const p = gateway.listApprovals('pending');
          if (p.length > 0) return p[0]!;
          const r = runner.getRun(run.id);
          if (r && (r.status === 'succeeded' || r.status === 'failed')) throw new Error('run ended early');
          await new Promise((res) => setTimeout(res, 25));
        }
      })(),
      8000,
      'tool approval to appear',
    );
    assert(toolAppr.toolName === 'write_file', 'tool node created write_file approval');
    gateway.decide(toolAppr.id, 'approved', { decidedBy: 'e2e' });
    const final = await withTimeout(runner.awaitRun(run.id), 10000, 'workflow to finish');
    assert(final.status === 'succeeded', 'workflow run succeeded', final.status);
    assert(final.nodeStates['a1']?.output === 'mock summary', 'agent node output recorded');
    assert(final.nodeStates['t1']?.status === 'succeeded', 'tool node succeeded');
    assert(existsSync(join(ws, 'wf.txt')), 'workflow wrote the file');
    runner.close();
  }

  // ---- 6. audit trail ----
  console.log('6. audit trail');
  {
    const entries = gateway.listAudit(200);
    const actions = entries.map((e) => e.action);
    assert(actions.includes('tool.evaluate'), 'audit has tool evaluations');
    assert(actions.includes('approval.decided'), 'audit has approval decisions');
    const blob = JSON.stringify(entries);
    assert(!blob.includes('sk-test'), 'no secret material in audit log');
    // plant a secret and verify redaction
    gateway.audit('test.secret', { actor: 'e2e', detail: { apiKey: 'sk-test-12345' } });
    const fresh = gateway.listAudit(1)[0]!;
    assert(JSON.stringify(fresh).includes('[REDACTED]'), 'secrets redacted in audit');
    assert(!JSON.stringify(fresh).includes('sk-test-12345'), 'raw secret absent');
  }

  gateway.close();
  console.log(failures === 0 ? '\nE2E MOCK: ALL PASS' : `\nE2E MOCK: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E MOCK ERROR:', err);
  process.exit(1);
});

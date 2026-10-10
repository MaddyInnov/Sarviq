// SPDX-License-Identifier: Apache-2.0
// Tests for the live code-writing stream event: after a successful
// write_file tool execution, runTurn emits { type: 'code_write' } carrying
// the file's before/after content for the animated code session view.
// Approval gates are untouched — the event fires post-execution.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider, scriptedBotTurn } from '../src/providers/mock.js';
import { createBuiltInTools } from '../src/tools/builtin.js';
import type { LLMProvider } from '../src/providers/factory.js';
import type { GovernanceDecision } from '../src/governance.js';
import type { BotConfig, StreamEvent, ToolDefinition } from '../src/types.js';

let dir: string;

const BOT: BotConfig = {
  id: 'bot-1',
  name: 'Test Coder',
  description: 'test',
  systemPrompt: 'You are a test bot.',
  provider: 'mock',
  model: 'mock-model',
  skills: [],
  tools: ['write_file', 'read_file'],
  mcpServers: [],
};

class AllowGateway {
  async classify(): Promise<GovernanceDecision> {
    return 'allow';
  }
  async evaluate(): Promise<{ decision: GovernanceDecision }> {
    return { decision: 'allow' };
  }
  async awaitDecision(): Promise<'approved' | 'denied'> {
    return 'approved';
  }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

class TestRuntime extends AgentRuntime {
  readonly mock: MockProvider;
  constructor(opts: ConstructorParameters<typeof AgentRuntime>[0], steps: Parameters<typeof MockProvider>[0]) {
    super(opts);
    this.mock = new MockProvider(steps);
  }
  protected override resolveProvider(_providerId: string): LLMProvider {
    return this.mock;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-codewrite-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(steps: Parameters<typeof MockProvider>[0]): TestRuntime {
  const tools = createBuiltInTools({ workspaceDir: dir });
  const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
  return new TestRuntime(
    {
      dbPath: join(dir, 'agent.db'),
      skillsDir: dir,
      governance: new AllowGateway() as never,
      toolRegistry: registry,
      defaultProviderId: 'mock',
    },
    steps,
  );
}

function codeWrites(events: StreamEvent[]): Extract<StreamEvent, { type: 'code_write' }>[] {
  return events.filter((e): e is Extract<StreamEvent, { type: 'code_write' }> => e.type === 'code_write');
}

describe('code_write stream event', () => {
  // The runtime snapshots "before" with a workspace-relative read (same as
  // the checkpoint hook), so run turns with cwd inside the workspace dir.
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
  });

  it('emits before=null/after=content for a brand-new file', async () => {
    const rt = makeRuntime(
      scriptedBotTurn(
        [{ id: 'c1', name: 'write_file', args: { path: 'hello.ts', content: 'const x = 1;\n' } }],
        'done',
      ),
    );
    const events: StreamEvent[] = [];
    await rt.runTurn({ bot: BOT, message: 'write hello', sessionId: 's1', onEvent: (e) => void events.push(e) });
    const writes = codeWrites(events);
    expect(writes).toHaveLength(1);
    const w = writes[0]!;
    expect(w.file).toBe('hello.ts');
    expect(w.before).toBeNull();
    expect(w.after).toBe('const x = 1;\n');
    expect(w.done).toBe(true);
    expect(w.botId).toBe('bot-1');
    expect(w.botName).toBe('Test Coder');
    expect(w.call.name).toBe('write_file');
    rt.close();
  });

  it('emits the previous content as before when overwriting', async () => {
    writeFileSync(join(dir, 'app.ts'), 'old content\n', 'utf-8');
    const rt = makeRuntime(
      scriptedBotTurn(
        [{ id: 'c1', name: 'write_file', args: { path: 'app.ts', content: 'new content\n' } }],
        'done',
      ),
    );
    const events: StreamEvent[] = [];
    await rt.runTurn({ bot: BOT, message: 'overwrite', sessionId: 's2', onEvent: (e) => void events.push(e) });
    const writes = codeWrites(events);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.before).toBe('old content\n');
    expect(writes[0]!.after).toBe('new content\n');
    rt.close();
  });

  it('emits nothing when no file is written', async () => {
    const rt = makeRuntime(scriptedBotTurn([], 'just chatting'));
    const events: StreamEvent[] = [];
    await rt.runTurn({ bot: BOT, message: 'hi', sessionId: 's3', onEvent: (e) => void events.push(e) });
    expect(codeWrites(events)).toHaveLength(0);
    rt.close();
  });

  it('emits nothing when the write is denied by governance', async () => {
    class DenyGateway extends AllowGateway {
      override async evaluate(): Promise<{ decision: GovernanceDecision }> {
        return { decision: 'deny' };
      }
    }
    const tools = createBuiltInTools({ workspaceDir: dir });
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const rt = new TestRuntime(
      {
        dbPath: join(dir, 'agent.db'),
        skillsDir: dir,
        governance: new DenyGateway() as never,
        toolRegistry: registry,
        defaultProviderId: 'mock',
      },
      scriptedBotTurn(
        [{ id: 'c1', name: 'write_file', args: { path: 'nope.ts', content: 'x' } }],
        'done',
      ),
    );
    const events: StreamEvent[] = [];
    await rt.runTurn({ bot: BOT, message: 'write', sessionId: 's4', onEvent: (e) => void events.push(e) });
    // Denied tools emit tool_result with denied:true but never code_write.
    expect(codeWrites(events)).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool_result' && e.denied)).toBe(true);
    rt.close();
  });
});

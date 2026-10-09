// SPDX-License-Identifier: Apache-2.0
// Tests for persistent agent environments (EnvironmentManager) with mocked E2B.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mock the e2b SDK before importing anything that touches it. ----
const mockKill = vi.fn(async () => {});
const mockRun = vi.fn(async (cmd: string, _opts: unknown) => ({
  wait: async () => ({ exitCode: 0 }),
  kill: vi.fn(async () => {}),
}));
const mockList = vi.fn(async (_path: string) => [
  { name: 'app.py', type: 'file' },
  { name: 'data', type: 'dir' },
]);
const mockSandboxInstance = {
  sandboxId: 'sbx-test-123',
  commands: { run: mockRun },
  files: { list: mockList },
  kill: mockKill,
};

vi.mock('e2b', () => ({
  Sandbox: {
    create: vi.fn(async () => mockSandboxInstance),
    connect: vi.fn(async (id: string) => {
      if (id === 'sbx-gone') throw new Error('sandbox not found');
      return { ...mockSandboxInstance, sandboxId: id };
    }),
  },
}));

import { DotStore } from '../src/dots.js';
import { EnvironmentManager, EnvironmentUnavailableError } from '../src/environments.js';

function freshDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
  const dotStore = new DotStore(dir);
  const dot = dotStore.create({
    name: 'watcher',
    responsibility: 'watch things',
    instructions: '',
    botId: 'helper',
    sessionId: 'sess-1',
    cron: '* * * * *',
  });
  return { dotStore, manager: new EnvironmentManager(dotStore), dot };
}

describe('EnvironmentManager', () => {
  beforeEach(() => {
    delete process.env.E2B_API_KEY;
    vi.clearAllMocks();
  });

  it('throws 503 without E2B_API_KEY (does not fake it)', async () => {
    const { manager, dot } = freshDeps();
    await expect(manager.ensure(dot.id)).rejects.toBeInstanceOf(EnvironmentUnavailableError);
    await expect(manager.exec(dot.id, 'ls')).rejects.toBeInstanceOf(EnvironmentUnavailableError);
    await expect(manager.listFiles(dot.id)).rejects.toBeInstanceOf(EnvironmentUnavailableError);
    try {
      await manager.ensure(dot.id);
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(503);
    }
  });

  it('creates a persistent sandbox and stores its ID on the Dot', async () => {
    process.env.E2B_API_KEY = 'test-key';
    const { manager, dotStore, dot } = freshDeps();
    const id = await manager.ensure(dot.id);
    expect(id).toBe('sbx-test-123');
    expect(dotStore.get(dot.id)?.environmentId).toBe('sbx-test-123');
    expect(manager.status(dot.id)).toEqual({ dotId: dot.id, hasEnvironment: true, sandboxId: 'sbx-test-123' });
  });

  it('reuses the existing sandbox on second ensure', async () => {
    process.env.E2B_API_KEY = 'test-key';
    const { manager, dot } = freshDeps();
    await manager.ensure(dot.id);
    const { Sandbox } = await import('e2b');
    const createCalls = (Sandbox.create as ReturnType<typeof vi.fn>).mock.calls.length;
    await manager.ensure(dot.id);
    // No second create — reconnected instead.
    expect((Sandbox.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(createCalls);
  });

  it('recreates the sandbox if the stored one is gone', async () => {
    process.env.E2B_API_KEY = 'test-key';
    const { manager, dotStore, dot } = freshDeps();
    dotStore.setEnvironmentId(dot.id, 'sbx-gone');
    const id = await manager.ensure(dot.id);
    expect(id).toBe('sbx-test-123'); // fresh sandbox created
  });

  it('exec runs a command in the persistent sandbox', async () => {
    process.env.E2B_API_KEY = 'test-key';
    const { manager, dot } = freshDeps();
    const result = await manager.exec(dot.id, 'echo hello');
    expect(result.exitCode).toBe(0);
    expect(mockRun).toHaveBeenCalled();
    const runCmd = mockRun.mock.calls[0][0] as string;
    expect(runCmd).toBe('echo hello');
    // Sandbox NOT killed (persists).
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('listFiles returns sandbox files', async () => {
    process.env.E2B_API_KEY = 'test-key';
    const { manager, dot } = freshDeps();
    const files = await manager.listFiles(dot.id, '/workspace');
    expect(files).toEqual([
      { name: 'app.py', type: 'file' },
      { name: 'data', type: 'dir' },
    ]);
    expect(mockList).toHaveBeenCalledWith('/workspace');
  });

  it('stop kills the sandbox and clears the Dot record', async () => {
    process.env.E2B_API_KEY = 'test-key';
    const { manager, dotStore, dot } = freshDeps();
    await manager.ensure(dot.id);
    await manager.stop(dot.id);
    expect(mockKill).toHaveBeenCalled();
    expect(dotStore.get(dot.id)?.environmentId).toBeUndefined();
    expect(manager.status(dot.id).hasEnvironment).toBe(false);
  });

  it('stop on a Dot without an environment is a no-op', async () => {
    const { manager, dot } = freshDeps();
    await expect(manager.stop(dot.id)).resolves.toBeUndefined();
  });

  it('returns 404 for unknown Dot', async () => {
    process.env.E2B_API_KEY = 'test-key';
    const { manager } = freshDeps();
    try {
      manager.status('nope');
      expect.unreachable();
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(404);
    }
  });
});

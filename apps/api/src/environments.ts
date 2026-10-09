// SPDX-License-Identifier: Apache-2.0
// Persistent agent environments — each Dot's "own computer" (OpenDots pattern).
//
// A Dot gets a long-lived E2B sandbox whose ID is persisted on the Dot
// record. The sandbox survives across turns (unlike the ephemeral per-command
// sandboxes in tools/sandbox.ts), so the Dot's files, installed packages, and
// running processes persist. The user can inspect/take over via the
// environment API routes.
//
// Requires E2B_API_KEY. Without it, all operations throw
// EnvironmentUnavailableError → mapped to HTTP 503 by the routes.

import {
  connectPersistentSandbox,
  createPersistentSandbox,
  executeInPersistentSandbox,
  killPersistentSandbox,
  listPersistentSandboxFiles,
} from '@mvp/agent-runtime';
import type { DotStore } from './dots.js';

export class EnvironmentUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(message = 'Persistent environments require E2B_API_KEY to be set.') {
    super(message);
    this.name = 'EnvironmentUnavailableError';
  }
}

export function requireE2B(): void {
  if (typeof process.env.E2B_API_KEY !== 'string' || process.env.E2B_API_KEY.trim() === '') {
    throw new EnvironmentUnavailableError();
  }
}

export interface EnvironmentStatus {
  dotId: string;
  hasEnvironment: boolean;
  sandboxId?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export class EnvironmentManager {
  constructor(private readonly dotStore: DotStore) {}

  /** Get the Dot or throw a 404-style error. */
  private dotOrThrow(dotId: string) {
    const dot = this.dotStore.get(dotId);
    if (!dot) {
      const err = new Error(`Unknown Dot "${dotId}"`) as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    return dot;
  }

  status(dotId: string): EnvironmentStatus {
    const dot = this.dotOrThrow(dotId);
    return {
      dotId: dot.id,
      hasEnvironment: !!dot.environmentId,
      sandboxId: dot.environmentId,
    };
  }

  /**
   * Ensure the Dot has a live persistent sandbox. Creates one if missing,
   * reconnects if the ID is stored. Returns the sandbox ID.
   */
  async ensure(dotId: string): Promise<string> {
    requireE2B();
    const dot = this.dotOrThrow(dotId);
    if (dot.environmentId) {
      // Verify it's still alive; recreate if expired.
      try {
        await connectPersistentSandbox(dot.environmentId);
        return dot.environmentId;
      } catch {
        this.dotStore.clearEnvironmentId(dotId);
      }
    }
    const sandboxId = await createPersistentSandbox();
    this.dotStore.setEnvironmentId(dotId, sandboxId);
    return sandboxId;
  }

  /** Run a command in the Dot's persistent sandbox (creates it if needed). */
  async exec(dotId: string, command: string, timeoutMs?: number): Promise<ExecResult> {
    requireE2B();
    if (!command.trim()) throw new Error('command is required');
    const sandboxId = await this.ensure(dotId);
    return executeInPersistentSandbox(sandboxId, command, { timeoutMs });
  }

  /** List files in the Dot's persistent sandbox. */
  async listFiles(
    dotId: string,
    path = '/',
  ): Promise<Array<{ name: string; type: 'file' | 'dir' }>> {
    requireE2B();
    const sandboxId = await this.ensure(dotId);
    return listPersistentSandboxFiles(sandboxId, path);
  }

  /** Terminate the Dot's persistent sandbox and clear the record. */
  async stop(dotId: string): Promise<void> {
    const dot = this.dotOrThrow(dotId);
    if (dot.environmentId) {
      await killPersistentSandbox(dot.environmentId);
      this.dotStore.clearEnvironmentId(dotId);
    }
  }
}

// SPDX-License-Identifier: Apache-2.0
//
// Minimal Agent Client Protocol (ACP) client — delegate subtasks to external
// coding agents (OpenCode, Claude Code, Codex, …) over stdio JSON-RPC.
// (Octop parity: `octop acp` delegates to OpenCode / Claude Code.)
//
// Wire format (minimal subset):
//   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"mvp","version":"0.1.0"}}}
//   ← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"opencode"}}}
//   → {"jsonrpc":"2.0","id":2,"method":"prompt","params":{"prompt":"...","sessionId":"..."}}
//   ← {"jsonrpc":"2.0","id":2,"result":{"text":"..."}}
//   → {"jsonrpc":"2.0","method":"cancel","params":{"sessionId":"..."}}   (notification)
// Unknown methods/notifications from the agent are ignored.

import { spawn, type ChildProcess } from 'node:child_process';

export interface AcpClientOptions {
  command: string;
  args?: string[];
  /** Working directory for the external agent (confined to the workspace). */
  cwd?: string;
  /** Spawn timeout ms. */
  spawnTimeoutMs?: number;
}

export class AcpError extends Error {}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Spawn an external ACP agent and speak the minimal protocol over stdio.
 * The child is spawned with cwd confined to the caller's workspace and a
 * scrubbed environment (no provider API keys leak into the external agent).
 */
export class AcpClient {
  private readonly opts: AcpClientOptions;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = '';
  private closed = false;

  constructor(opts: AcpClientOptions) {
    if (!opts.command || !opts.command.trim()) {
      throw new AcpError('ACP: "command" is required');
    }
    this.opts = opts;
  }

  /** Spawn the process and run `initialize`. */
  async connect(): Promise<{ agentName: string }> {
    if (this.proc) return { agentName: 'unknown' };
    // Scrub secrets from the child environment — the external agent gets its
    // own credentials (e.g. its own CLI login), never ours.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
      env[k] = v;
    }
    this.proc = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout?.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
    this.proc.stderr?.on('data', () => {
      // Swallow stderr (agent logs); the protocol runs on stdout.
    });
    this.proc.on('close', () => this.onClose(new AcpError('ACP agent process exited')));
    this.proc.on('error', (err) =>
      this.onClose(err instanceof AcpError ? err : new AcpError(`ACP spawn failed: ${err.message}`)),
    );

    const result = (await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'mvp-all-in-one-agent', version: '0.1.0' },
    })) as { protocolVersion?: number; agentInfo?: { name?: string } };
    return { agentName: result?.agentInfo?.name ?? 'unknown' };
  }

  /**
   * Send a prompt and await the agent's final text. The result is returned
   * raw — the caller (delegate tool) tags it untrusted via the runtime's
   * standard tool-output tagging, exactly like any other tool result.
   */
  async prompt(text: string, opts?: { sessionId?: string; timeoutMs?: number }): Promise<string> {
    const result = (await this.request(
      'prompt',
      { prompt: text, ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}) },
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )) as { text?: string } | string;
    if (typeof result === 'string') return result;
    return result?.text ?? '';
  }

  /** Best-effort cancellation notification. */
  cancel(sessionId?: string): void {
    this.sendNotification('cancel', sessionId ? { sessionId } : {});
  }

  close(): void {
    this.onClose(new AcpError('ACP client closed'));
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.proc?.stdin || this.closed) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      // best effort
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.proc?.stdin || this.closed) {
      return Promise.reject(new AcpError('ACP client is not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(`ACP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new AcpError(String(err)));
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: { jsonrpc?: string; id?: number; method?: string; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(trimmed) as typeof msg;
      } catch {
        continue; // not protocol traffic — ignore
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new AcpError(`ACP error: ${msg.error.message ?? 'unknown'}`));
        else pending.resolve(msg.result);
      }
      // Notifications / unknown methods from the agent are ignored.
    }
  }

  private onClose(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** Parse a bot's ACP config into client options. Returns null when not configured. */
export function acpOptionsFromBot(bot: { acp?: { command?: string; args?: string[] } } | undefined): AcpClientOptions | null {
  const command = bot?.acp?.command?.trim();
  if (!command) return null;
  return {
    command,
    args: Array.isArray(bot!.acp!.args) ? bot!.acp!.args.filter((a) => typeof a === 'string') : [],
  };
}

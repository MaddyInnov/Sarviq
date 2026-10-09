// SPDX-License-Identifier: Apache-2.0
// Interactive terminal sessions (Terminal AI+).
//
// A persistent shell the user drives from the browser (xterm.js) with an
// AI side-panel that suggests/explains commands. Backends, in preference
// order:
//   1. `pty`    — node-pty when installed (real PTY: colors, curses apps).
//   2. `docker` — `docker run -i --rm` with the workspace mounted (sandboxed,
//                  interactive pipes; no TTY resize without a controlling tty).
//   3. `host`   — stateful `child_process.spawn(shell)` on the API host.
//                  Reported honestly as NOT sandboxed; the UI shows a warning.
//
// All sessions start with cwd = the configured workspace dir. Output is kept
// in a per-session ring buffer so reconnecting SSE clients get history.

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

export type TerminalBackendKind = 'pty' | 'docker' | 'host';
export type TerminalStatus = 'open' | 'closed';

export interface TerminalSession {
  id: string;
  name: string;
  status: TerminalStatus;
  backend: TerminalBackendKind;
  /** True when the shell runs inside a sandbox (docker). Host/pty are not sandboxed. */
  sandboxed: boolean;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  closedAt?: number;
}

export interface CreateTerminalOptions {
  name?: string;
  cols?: number;
  rows?: number;
  workspaceDir: string;
  /** Docker image for the sandboxed backend. Default: 'alpine'. */
  dockerImage?: string;
}

interface LiveSession {
  meta: TerminalSession;
  proc: ChildProcess;
  pty?: { write: (d: string) => void; resize: (c: number, r: number) => void; kill: () => void };
  output: string;
  subscribers: Set<(chunk: string) => void>;
}

const MAX_OUTPUT = 256 * 1024; // ring buffer per session
const MAX_WRITE = 64 * 1024; // max bytes per input write
const DOCKER_BOOT_TIMEOUT_MS = 25_000;

function appendOutput(live: LiveSession, chunk: string): void {
  live.output += chunk;
  if (live.output.length > MAX_OUTPUT) {
    live.output = live.output.slice(live.output.length - MAX_OUTPUT);
  }
  for (const fn of live.subscribers) {
    try {
      fn(chunk);
    } catch {
      // subscriber gone; SSE cleanup removes it on close
    }
  }
}

function shellForPlatform(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoExit'] };
  return { cmd: process.env.SHELL || '/bin/sh', args: [] };
}

function dockerAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function tryLoadNodePty(): unknown | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node-pty');
  } catch {
    return undefined;
  }
}

export class TerminalManager {
  private readonly sessions = new Map<string, LiveSession>();

  /**
   * Injectable process spawner (tests pass a fake; production uses
   * child_process.spawn). Signature mirrors spawn(cmd, args, opts).
   * `probes` overrides backend detection so tests are hermetic regardless
   * of whether node-pty/docker exist on the machine running them.
   */
  constructor(
    private readonly spawnFn: (
      cmd: string,
      args: string[],
      opts: { cwd: string; env: NodeJS.ProcessEnv },
    ) => ChildProcess = (cmd, args, opts) => spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }),
    private readonly probes: {
      pty?: () => unknown | undefined;
      docker?: () => boolean;
    } = {},
  ) {}

  async create(opts: CreateTerminalOptions): Promise<TerminalSession> {
    const id = randomUUID();
    const cols = Math.min(Math.max(opts.cols ?? 100, 20), 300);
    const rows = Math.min(Math.max(opts.rows ?? 30, 5), 120);
    const meta: TerminalSession = {
      id,
      name: (opts.name ?? '').trim().slice(0, 80) || `terminal-${id.slice(0, 8)}`,
      status: 'open',
      backend: 'host',
      sandboxed: false,
      cwd: opts.workspaceDir,
      cols,
      rows,
      createdAt: Date.now(),
    };

    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' };
    const nodePty = this.probes.pty ? this.probes.pty() : tryLoadNodePty();

    if (nodePty && typeof (nodePty as { spawn?: unknown }).spawn === 'function') {
      const ptyMod = nodePty as {
        spawn: (file: string, args: string[], o: Record<string, unknown>) => {
          onData: (fn: (d: string) => void) => void;
          onExit: (fn: (e: { exitCode: number }) => void) => void;
          write: (d: string) => void;
          resize: (c: number, r: number) => void;
          kill: () => void;
        };
      };
      const shell = shellForPlatform();
      const p = ptyMod.spawn(shell.cmd, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: opts.workspaceDir,
        env,
      });
      meta.backend = 'pty';
      const live: LiveSession = { meta, proc: undefined as unknown as ChildProcess, pty: p, output: '', subscribers: new Set() };
      p.onData((d) => appendOutput(live, d));
      p.onExit(() => this.markClosed(id));
      this.sessions.set(id, live);
      return { ...meta };
    }

    const dockerUp = this.probes.docker ? this.probes.docker() : dockerAvailable();
    if (dockerUp) {
      try {
        const image = opts.dockerImage || 'alpine';
        const proc = await this.spawnDocker(image, opts.workspaceDir, cols, rows, env);
        meta.backend = 'docker';
        meta.sandboxed = true;
        this.attachProc(id, meta, proc);
        return { ...meta };
      } catch {
        // fall through to host shell
      }
    }

    const shell = shellForPlatform();
    const proc = this.spawnFn(shell.cmd, shell.args, { cwd: opts.workspaceDir, env });
    this.attachProc(id, meta, proc);
    return { ...meta };
  }

  private spawnDocker(
    image: string,
    workspaceDir: string,
    _cols: number,
    _rows: number,
    env: NodeJS.ProcessEnv,
  ): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnFn(
        'docker',
        ['run', '--rm', '-i', '-w', '/workspace', '-v', `${workspaceDir}:/workspace`, image, '/bin/sh'],
        { cwd: workspaceDir, env },
      );
      const timer = setTimeout(() => reject(new Error('docker boot timeout')), DOCKER_BOOT_TIMEOUT_MS);
      const onErr = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };
      proc.once('error', onErr);
      // Consider the container booted once it produces any output or the
      // stdio streams are flowing. We resolve on first data OR after a short
      // grace period so `docker run` image pulls don't hang creation forever.
      const ready = (): void => {
        clearTimeout(timer);
        proc.off('error', onErr);
        resolve(proc);
      };
      const grace = setTimeout(ready, 3000);
      proc.stdout?.once('data', () => {
        clearTimeout(grace);
        ready();
      });
      proc.stderr?.once('data', () => {
        clearTimeout(grace);
        ready();
      });
    });
  }

  private attachProc(id: string, meta: TerminalSession, proc: ChildProcess): void {
    const live: LiveSession = { meta, proc, output: '', subscribers: new Set() };
    proc.stdout?.on('data', (d: Buffer) => appendOutput(live, d.toString('utf8')));
    proc.stderr?.on('data', (d: Buffer) => appendOutput(live, d.toString('utf8')));
    proc.on('exit', () => this.markClosed(id));
    proc.on('error', () => this.markClosed(id));
    this.sessions.set(id, live);
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }));
  }

  get(id: string): TerminalSession | undefined {
    const s = this.sessions.get(id);
    return s ? { ...s.meta } : undefined;
  }

  /** Buffered output (for reconnecting clients). */
  output(id: string): string | undefined {
    return this.sessions.get(id)?.output;
  }

  write(id: string, data: string): boolean {
    const live = this.sessions.get(id);
    if (!live || live.meta.status !== 'open') return false;
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_WRITE) return false;
    try {
      if (live.pty) {
        live.pty.write(data);
      } else {
        live.proc.stdin?.write(data);
      }
      return true;
    } catch {
      return false;
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const live = this.sessions.get(id);
    if (!live || live.meta.status !== 'open') return false;
    live.meta.cols = Math.min(Math.max(cols, 20), 300);
    live.meta.rows = Math.min(Math.max(rows, 5), 120);
    try {
      live.pty?.resize(live.meta.cols, live.meta.rows);
      return true;
    } catch {
      return false;
    }
  }

  subscribe(id: string, fn: (chunk: string) => void): () => void {
    const live = this.sessions.get(id);
    if (!live) return () => undefined;
    live.subscribers.add(fn);
    return () => {
      live.subscribers.delete(fn);
    };
  }

  close(id: string): boolean {
    const live = this.sessions.get(id);
    if (!live || live.meta.status !== 'open') return false;
    try {
      if (live.pty) {
        live.pty.kill();
      } else {
        live.proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (live.meta.status === 'open') live.proc.kill('SIGKILL');
          } catch {
            // already gone
          }
        }, 2000).unref?.();
      }
    } catch {
      // fall through to markClosed
    }
    this.markClosed(id);
    return true;
  }

  private markClosed(id: string): void {
    const live = this.sessions.get(id);
    if (!live || live.meta.status === 'closed') return;
    live.meta.status = 'closed';
    live.meta.closedAt = Date.now();
    for (const fn of live.subscribers) {
      try {
        fn('\r\n[session closed]\r\n');
      } catch {
        // ignore
      }
    }
    live.subscribers.clear();
  }

  /** Test helper: inject output as if the shell produced it. */
  emitForTest(id: string, chunk: string): boolean {
    const live = this.sessions.get(id);
    if (!live) return false;
    appendOutput(live, chunk);
    return true;
  }
}

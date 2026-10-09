// SPDX-License-Identifier: Apache-2.0
// HTTP routes for interactive terminal sessions (Terminal AI+).
//
//   POST   /sessions                 → create a persistent shell session
//   GET    /sessions                 → list sessions
//   POST   /sessions/:id/input       → write keystrokes { data }
//   POST   /sessions/:id/resize      → { cols, rows }
//   GET    /sessions/:id/stream      → SSE: buffered history + live output
//   DELETE /sessions/:id            → kill the session
//   POST   /ai/suggest               → { sessionId?, goal } → { command, explanation }
//   POST   /ai/run                   → { sessionId, command } → approval-gated write
//
// AI-suggested commands never run without an explicit governance approval:
// the endpoint mints an approval and waits for the user's inbox decision
// (fail-closed on timeout/deny), exactly like the GitHub PR flow.

import express, { type Request, type Response, type Router } from 'express';
import { TerminalManager } from './terminal.js';
import type { AgentRuntime, BotConfig, StreamEvent } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';

export interface TerminalRouteDeps {
  workspaceDir: string;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  governance: GovernanceGateway;
  dockerImage?: string;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/** Parse the agent's reply into { command, explanation }; tolerant of fences. */
export function parseSuggestion(text: string): { command: string; explanation: string } | undefined {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const command = typeof obj.command === 'string' ? obj.command.trim() : '';
    const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim() : '';
    if (!command) return undefined;
    return { command, explanation };
  } catch {
    return undefined;
  }
}

export function registerTerminalRoutes(router: Router, deps: TerminalRouteDeps): TerminalManager {
  const manager = new TerminalManager();

  router.post('/sessions', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { name?: unknown; cols?: unknown; rows?: unknown };
    try {
      const session = await manager.create({
        name: typeof body.name === 'string' ? body.name : undefined,
        cols: typeof body.cols === 'number' ? body.cols : undefined,
        rows: typeof body.rows === 'number' ? body.rows : undefined,
        workspaceDir: deps.workspaceDir,
        dockerImage: deps.dockerImage,
      });
      res.json({ ok: true, session });
    } catch (err) {
      res.status(500).json(errorBody('Failed to create terminal session', err instanceof Error ? err.message : String(err)));
    }
  });

  router.get('/sessions', (_req: Request, res: Response) => {
    res.json({ ok: true, sessions: manager.list() });
  });

  router.post('/sessions/:id/input', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid session id'));
      return;
    }
    const body = (req.body ?? {}) as { data?: unknown };
    if (typeof body.data !== 'string' || body.data.length === 0) {
      res.status(400).json(errorBody('"data" must be a non-empty string'));
      return;
    }
    if (!manager.write(id, body.data)) {
      res.status(404).json(errorBody(`Unknown or closed session "${id}"`));
      return;
    }
    res.json({ ok: true });
  });

  router.post('/sessions/:id/resize', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid session id'));
      return;
    }
    const body = (req.body ?? {}) as { cols?: unknown; rows?: unknown };
    if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
      res.status(400).json(errorBody('"cols" and "rows" must be numbers'));
      return;
    }
    if (!manager.resize(id, body.cols, body.rows)) {
      res.status(404).json(errorBody(`Unknown or closed session "${id}"`));
      return;
    }
    res.json({ ok: true });
  });

  router.get('/sessions/:id/stream', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id) || !manager.get(id)) {
      res.status(404).json(errorBody(`Unknown session "${id}"`));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const send = (chunk: string): void => {
      try {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      } catch {
        // client gone; cleanup below removes the subscriber
      }
    };
    // Replay buffered history so reconnects don't lose the scrollback.
    const history = manager.output(id);
    if (history) send(history);
    const unsubscribe = manager.subscribe(id, send);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // ignore; close handler cleans up
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.delete('/sessions/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid session id'));
      return;
    }
    if (!manager.close(id)) {
      res.status(404).json(errorBody(`Unknown or closed session "${id}"`));
      return;
    }
    res.json({ ok: true, closed: id });
  });

  // ---- AI assist -----------------------------------------------------------
  router.post('/ai/suggest', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { sessionId?: unknown; goal?: unknown };
    const goal = typeof body.goal === 'string' ? body.goal.trim().slice(0, 2000) : '';
    if (!goal) {
      res.status(400).json(errorBody('"goal" is required'));
      return;
    }
    const bots = deps.getBots();
    const bot = bots.find((b) => b.id === 'helper') ?? bots[0];
    if (!bot) {
      res.status(503).json(errorBody('No bots configured'));
      return;
    }
    const sessionId =
      typeof body.sessionId === 'string' && validId(body.sessionId) ? body.sessionId : undefined;
    const session = sessionId ? manager.get(sessionId) : undefined;
    const prompt = [
      'You are a shell assistant inside an interactive terminal.',
      `Working directory: ${deps.workspaceDir} (${process.platform}).`,
      `User goal: ${goal}`,
      'Reply with ONLY a JSON object: {"command": "<single safe shell command>", "explanation": "<one or two sentences>"}.',
      'Prefer read-only or low-risk commands. Never suggest destructive commands (rm -rf /, mkfs, dd, fork bombs).',
      session ? `The terminal backend is "${session.backend}".` : '',
    ].join('\n');
    let text = '';
    try {
      await deps.agentRuntime.runTurn({
        bot,
        message: prompt,
        sessionId: `terminal_ai_${Date.now().toString(36)}`,
        taskType: 'chat',
        onEvent: async (e: StreamEvent) => {
          if (e.type === 'token') text += e.content;
        },
      });
    } catch (err) {
      res.status(500).json(errorBody('AI suggest failed', err instanceof Error ? err.message : String(err)));
      return;
    }
    const suggestion = parseSuggestion(text);
    if (!suggestion) {
      res.status(502).json(errorBody('Could not parse a command suggestion from the model'));
      return;
    }
    res.json({ ok: true, ...suggestion });
  });

  router.post('/ai/run', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { sessionId?: unknown; command?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const command = typeof body.command === 'string' ? body.command.trim().slice(0, 4000) : '';
    if (!validId(sessionId) || !command) {
      res.status(400).json(errorBody('"sessionId" and "command" are required'));
      return;
    }
    if (!manager.get(sessionId)) {
      res.status(404).json(errorBody(`Unknown session "${sessionId}"`));
      return;
    }
    // Approval gate: mint an approval, wait for the inbox decision.
    const approvalId = deps.governance.requestApproval(
      'terminal.run',
      { sessionId, command },
      { sessionId: 'api', botId: 'api', actor: 'user' },
      { provenance: 'terminal-ai' },
    );
    let verdict: string;
    try {
      verdict = await deps.governance.awaitDecision(approvalId, 120_000);
    } catch {
      res.status(408).json(errorBody('Approval timed out — command not run'));
      return;
    }
    if (verdict !== 'approved') {
      res.status(403).json(errorBody('Denied — command not run'));
      return;
    }
    if (!manager.write(sessionId, command + '\n')) {
      res.status(410).json(errorBody('Session closed before the command could run'));
      return;
    }
    res.json({ ok: true, ran: command });
  });

  return manager;
}

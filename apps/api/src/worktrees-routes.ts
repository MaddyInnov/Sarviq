// SPDX-License-Identifier: Apache-2.0
// HTTP routes for git worktrees (OpenCode parity, P3-A).
//
// Endpoints (all under the mount point):
//   POST   /worktrees                 → create a worktree { repo?, branch?, base? }
//   GET    /worktrees?repo=           → list worktrees of a repo
//   DELETE /worktrees                 → remove { repo?, path, force? }
//   POST   /sessions/:id/worktree      → create a worktree and bind it to a coding session
//   GET    /sessions/:id/worktree     → bound worktree path (or null)
//   DELETE /sessions/:id/worktree     → detach; with { delete: true, force? } also removes it
//
// MOUNT POINT (wiring belongs to the API host; index.ts is owned by another
// workstream — report, don't edit):
//   import { registerWorktreeRoutes } from './worktrees-routes.js';
//   const worktreeRouter = express.Router();
//   registerWorktreeRoutes(worktreeRouter, {
//     workspaceDir: config.workspaceDir,
//     worktreeRoot: `${config.workspaceDir}/.worktrees`,
//     sessionStore: agentRuntime.sessionStore,
//   });
//   router.use('/worktrees', worktreeRouter);
//
// These are explicit user-initiated HTTP actions (same category as the
// terminal routes), not model tool calls — the agent-facing equivalents are
// the `worktree_*` tools from createWorktreeTools(), which DO flow through
// the normal governance approval path.

import type { Request, Response, Router } from 'express';
import { resolve } from 'node:path';
import { WorktreeManager, type CreateWorktreeOptions } from '@mvp/agent-runtime';
import type { SessionStore } from '@mvp/agent-runtime';

export interface WorktreeRouteDeps {
  /** Workspace root; repo/worktree paths must resolve inside it. */
  workspaceDir: string;
  /** Root new worktrees are created under (must be inside workspaceDir). */
  worktreeRoot: string;
  /** The runtime's session store (agentRuntime.sessionStore). */
  sessionStore: SessionStore;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function statusFromError(err: unknown): { status: number; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not a git repo|no worktree|not registered|invalid branch|escapes workspace|outside the worktree root|main worktree/i.test(msg)) {
    return { status: 400, message: msg };
  }
  if (/uncommitted changes/i.test(msg)) return { status: 409, message: msg };
  return { status: 500, message: msg };
}

export function registerWorktreeRoutes(router: Router, deps: WorktreeRouteDeps): void {
  const mgr = new WorktreeManager(deps.worktreeRoot);

  const resolveRepo = (req: Request): string => {
    const raw = typeof req.query.repo === 'string' && req.query.repo ? req.query.repo : '.';
    const abs = resolve(deps.workspaceDir, raw);
    const root = resolve(deps.workspaceDir);
    if (abs !== root && !abs.startsWith(root + '/')) {
      throw new Error(`Path escapes workspace: "${raw}"`);
    }
    return abs;
  };

  const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

  // POST /worktrees → create
  router.post('/worktrees', (req: Request, res: Response) => {
    try {
      const b = body(req);
      const opts: CreateWorktreeOptions = {};
      if (b.branch !== undefined) opts.branch = String(b.branch);
      if (b.base !== undefined) opts.base = String(b.base);
      if (b.force === true) opts.force = true;
      const info = mgr.create(resolveRepo(req), opts);
      res.json({ ok: true, worktree: info });
    } catch (err) {
      const { status, message } = statusFromError(err);
      res.status(status).json(errorBody(message));
    }
  });

  // GET /worktrees?repo= → list
  router.get('/worktrees', (req: Request, res: Response) => {
    try {
      res.json({ ok: true, worktrees: mgr.list(resolveRepo(req)) });
    } catch (err) {
      const { status, message } = statusFromError(err);
      res.status(status).json(errorBody(message));
    }
  });

  // DELETE /worktrees → remove { repo?, path, force? }
  router.delete('/worktrees', (req: Request, res: Response) => {
    try {
      const b = body(req);
      const target = typeof b.path === 'string' ? b.path : '';
      if (!target) {
        res.status(400).json(errorBody('"path" is required'));
        return;
      }
      mgr.remove(resolveRepo(req), target, { force: b.force === true });
      res.json({ ok: true, removed: target });
    } catch (err) {
      const { status, message } = statusFromError(err);
      res.status(status).json(errorBody(message));
    }
  });

  // POST /sessions/:id/worktree → create a worktree and bind it to the session
  router.post('/sessions/:id/worktree', (req: Request, res: Response) => {
    try {
      const b = body(req);
      const opts: CreateWorktreeOptions = {};
      if (b.branch !== undefined) opts.branch = String(b.branch);
      if (b.base !== undefined) opts.base = String(b.base);
      const info = mgr.create(resolveRepo(req), opts);
      deps.sessionStore.attachWorktree(req.params.id, info.path);
      res.json({ ok: true, sessionId: req.params.id, worktree: info });
    } catch (err) {
      const { status, message } = statusFromError(err);
      res.status(status).json(errorBody(message));
    }
  });

  // GET /sessions/:id/worktree → bound path or null
  router.get('/sessions/:id/worktree', (req: Request, res: Response) => {
    try {
      const path = deps.sessionStore.getWorktree(req.params.id) ?? null;
      res.json({ ok: true, sessionId: req.params.id, worktreePath: path });
    } catch (err) {
      const { status, message } = statusFromError(err);
      res.status(status).json(errorBody(message));
    }
  });

  // DELETE /sessions/:id/worktree → detach; { delete: true } also removes it
  router.delete('/sessions/:id/worktree', (req: Request, res: Response) => {
    try {
      const b = body(req);
      const bound = deps.sessionStore.getWorktree(req.params.id);
      deps.sessionStore.detachWorktree(req.params.id);
      let deleted: string | null = null;
      if (b.delete === true && bound) {
        mgr.remove(resolveRepo(req), bound, { force: b.force === true });
        deleted = bound;
      }
      res.json({ ok: true, sessionId: req.params.id, detached: bound ?? null, deleted });
    } catch (err) {
      const { status, message } = statusFromError(err);
      res.status(status).json(errorBody(message));
    }
  });
}
